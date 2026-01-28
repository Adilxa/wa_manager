const TelegramBot = require('node-telegram-bot-api');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

// Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '6252681855:AAHRCXOob22ZkLl-eowZXqBu0mZ7TG8ir_Y';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1002551603042'; // Извлечено из ссылки
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 минут
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Services status tracker
let lastStatus = {
  postgres: false,
  redis: false,
  waManager: false,
  timestamp: null
};

// Log function
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Send Telegram notification
async function sendNotification(message) {
  try {
    const timestamp = new Date().toLocaleString('ru-RU', {
      timeZone: 'Asia/Almaty',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const fullMessage = `Мониторинг WA Manager\n${timestamp}\n\n${message}`;
    await bot.sendMessage(CHAT_ID, fullMessage);
    log(`Notification sent: ${message}`);
  } catch (error) {
    log(`Failed to send notification: ${error.message}`);
  }
}

// Check PostgreSQL
async function checkPostgres() {
  try {
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    return { status: true, message: '✅ PostgreSQL работает' };
  } catch (error) {
    log(`PostgreSQL check failed: ${error.message}`);
    return { status: false, message: '❌ PostgreSQL не работает', error: error.message };
  }
}

// Check Redis
async function checkRedis() {
  let client;
  try {
    client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null // Don't retry
    });

    await client.ping();
    client.disconnect();

    return { status: true, message: '✅ Redis работает' };
  } catch (error) {
    log(`Redis check failed: ${error.message}`);
    if (client) {
      try { client.disconnect(); } catch (e) {}
    }
    return { status: false, message: '❌ Redis не работает', error: error.message };
  }
}

// Check WA Manager (API and Frontend)
async function checkWAManager() {
  try {
    // Check API health endpoint
    const apiResponse = await fetch('http://localhost:5001/health', {
      timeout: 5000
    });

    if (!apiResponse.ok) {
      throw new Error(`API returned status ${apiResponse.status}`);
    }

    // Check frontend
    const frontendResponse = await fetch('http://localhost:3000', {
      timeout: 5000
    });

    if (!frontendResponse.ok) {
      throw new Error(`Frontend returned status ${frontendResponse.status}`);
    }

    return { status: true, message: '✅ WA Manager работает' };
  } catch (error) {
    log(`WA Manager check failed: ${error.message}`);
    return { status: false, message: '❌ WA Manager не работает', error: error.message };
  }
}

// Restart services using PM2 (only for WA Manager processes inside container)
async function restartWAManagerServices() {
  try {
    log('Attempting to restart WA Manager services via PM2...');

    // Try to restart API server
    try {
      await execPromise('pm2 restart whatsapp-api');
      log('API server restarted');
    } catch (err) {
      log(`Failed to restart API: ${err.message}`);
    }

    // Try to restart frontend
    try {
      await execPromise('pm2 restart nextjs-frontend');
      log('Frontend restarted');
    } catch (err) {
      log(`Failed to restart frontend: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s

    const check = await checkWAManager();
    if (check.status) {
      await sendNotification('🔄 WA Manager был перезапущен через PM2 и теперь работает');
      return true;
    }
    return false;
  } catch (error) {
    log(`Failed to restart WA Manager: ${error.message}`);
    await sendNotification(`⚠️ Не удалось перезапустить WA Manager через PM2: ${error.message}`);
    return false;
  }
}

// Main monitoring function
async function monitorServices() {
  log('Starting services check...');

  const results = {
    postgres: await checkPostgres(),
    redis: await checkRedis(),
    waManager: await checkWAManager()
  };

  // Check if any service is down
  const servicesDown = [];
  if (!results.postgres.status) servicesDown.push('PostgreSQL');
  if (!results.redis.status) servicesDown.push('Redis');
  if (!results.waManager.status) servicesDown.push('WA Manager');

  // Auto-restart failed services or send alerts
  if (servicesDown.length > 0) {
    log(`Services down: ${servicesDown.join(', ')}`);

    // Send alert
    await sendNotification(
      `⚠️ ВНИМАНИЕ! Обнаружены неработающие сервисы:\n\n` +
      `${results.postgres.message}\n` +
      `${results.redis.message}\n` +
      `${results.waManager.message}\n\n` +
      `Начинаю автоматическое восстановление...`
    );

    // Try to restart WA Manager services via PM2
    let waManagerRestarted = false;
    if (!results.waManager.status) {
      waManagerRestarted = await restartWAManagerServices();
    }

    // For PostgreSQL and Redis - Docker will auto-restart them
    // We just wait and check again
    if (!results.postgres.status || !results.redis.status) {
      log('Waiting for Docker auto-restart of PostgreSQL/Redis...');
      await sendNotification(
        `⏳ PostgreSQL и Redis перезапустятся автоматически через Docker.\nОжидание 30 секунд...`
      );
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    // Re-check after restarts
    await new Promise(resolve => setTimeout(resolve, 10000));
    const finalResults = {
      postgres: await checkPostgres(),
      redis: await checkRedis(),
      waManager: await checkWAManager()
    };

    const stillDown = [];
    if (!finalResults.postgres.status) stillDown.push('PostgreSQL');
    if (!finalResults.redis.status) stillDown.push('Redis');
    if (!finalResults.waManager.status) stillDown.push('WA Manager');

    if (stillDown.length > 0) {
      await sendNotification(
        `❌ КРИТИЧНО! Не удалось восстановить сервисы:\n${stillDown.join(', ')}\n\n` +
        `${finalResults.postgres.message}\n` +
        `${finalResults.redis.message}\n` +
        `${finalResults.waManager.message}\n\n` +
        `Требуется ручное вмешательство!`
      );
    } else {
      await sendNotification(
        `✅ Все сервисы успешно восстановлены!\n\n` +
        `${finalResults.postgres.message}\n` +
        `${finalResults.redis.message}\n` +
        `${finalResults.waManager.message}`
      );
    }
  } else {
    // All services are OK
    log('All services are running');

    // Send periodic status update every 15 minutes
    const statusChanged =
      lastStatus.postgres !== results.postgres.status ||
      lastStatus.redis !== results.redis.status ||
      lastStatus.waManager !== results.waManager.status ||
      !lastStatus.timestamp ||
      (Date.now() - lastStatus.timestamp) >= CHECK_INTERVAL;

    if (statusChanged) {
      await sendNotification(
        `${results.postgres.message}\n` +
        `${results.redis.message}\n` +
        `${results.waManager.message}`
      );
    }
  }

  // Update last status
  lastStatus = {
    postgres: results.postgres.status,
    redis: results.redis.status,
    waManager: results.waManager.status,
    timestamp: Date.now()
  };
}

// Start monitoring
async function start() {
  log('WA Manager Monitor started');
  log(`Monitoring interval: ${CHECK_INTERVAL / 60000} minutes`);
  log(`Telegram chat ID: ${CHAT_ID}`);

  // Send startup notification
  await sendNotification('🚀 Система мониторинга WA Manager запущена');

  // Run first check immediately
  await monitorServices();

  // Schedule periodic checks
  setInterval(async () => {
    try {
      await monitorServices();
    } catch (error) {
      log(`Error in monitoring cycle: ${error.message}`);
    }
  }, CHECK_INTERVAL);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down...');
  await sendNotification('🛑 Система мониторинга WA Manager остановлена');
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Received SIGINT, shutting down...');
  await sendNotification('🛑 Система мониторинга WA Manager остановлена');
  process.exit(0);
});

// Start the monitor
start().catch(error => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
