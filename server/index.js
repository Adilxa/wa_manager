const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// Logger configuration
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: false,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

// ==================== CONFIGURATION ====================

const CONFIG = {
  // Reconnection settings
  RECONNECT_MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY: 1000, // 1 second
  RECONNECT_MAX_DELAY: 300000, // 5 minutes max

  // Heartbeat settings
  HEARTBEAT_INTERVAL: 30000, // Check every 30 seconds
  HEARTBEAT_TIMEOUT: 10000, // 10 second timeout for ping

  // Initialization timeout
  INIT_TIMEOUT: 120000, // 2 minutes to initialize

  // Rate limiting - БЕЗОПАСНЫЕ значения для избежания бана
  RATE_LIMIT_WINDOW: 60000, // 1 minute window
  RATE_LIMIT_MAX_MESSAGES: 20, // Max 20 messages per minute (было 100)

  // Дневные лимиты для нового аккаунта
  DAILY_MESSAGE_LIMIT_NEW_ACCOUNT: 500, // Для аккаунтов младше 7 дней
  DAILY_MESSAGE_LIMIT_OLD_ACCOUNT: 1000, // Для старых аккаунтов
  DAILY_NEW_CHATS_LIMIT: 100, // Максимум новых чатов в день

  // Memory management
  MEMORY_CHECK_INTERVAL: 60000, // Check every minute
  MEMORY_WARNING_THRESHOLD: 0.75, // Warn at 75%
  MEMORY_CRITICAL_THRESHOLD: 0.85, // Critical at 85%

  // Message queue
  MESSAGE_RETRY_COUNT: 3,
  MESSAGE_RETRY_DELAY: 5000, // 5 seconds between retries

  // Resource monitoring
  RESOURCE_MONITOR_INTERVAL: 300000, // 5 minutes

  // Human-like behavior delays (в миллисекундах)
  TYPING_SPEED_MIN: 30, // Минимальная скорость печати (мс на символ)
  TYPING_SPEED_MAX: 100, // Максимальная скорость печати (мс на символ)
  DELAY_BEFORE_TYPING_MIN: 500, // Задержка перед началом печати
  DELAY_BEFORE_TYPING_MAX: 2000,
  DELAY_BETWEEN_MESSAGES_MIN: 3000, // Задержка между сообщениями
  DELAY_BETWEEN_MESSAGES_MAX: 8000,
  REST_AFTER_MESSAGES: 5, // Отдых после N сообщений
  REST_DURATION_MIN: 30000, // Минимальное время отдыха (30 сек)
  REST_DURATION_MAX: 120000, // Максимальное время отдыха (2 мин)
};

// ==================== STATE MANAGEMENT ====================

// Store active WhatsApp sockets
const clients = new Map();

// Track reconnection attempts
const reconnectAttempts = new Map();

// Track accounts being connected (prevent race conditions)
const connectingAccounts = new Set();

// Rate limiting tracker
const rateLimiter = new Map();

// Daily limits tracker
const dailyLimits = new Map();

// Message counters for rest periods
const messageCounters = new Map();

// Message queue for retry logic
const messageQueues = new Map();

// Contract processing tracker
const activeContracts = new Map();

// Graceful shutdown flag
let isShuttingDown = false;

// Heartbeat interval reference
let heartbeatInterval = null;

// Memory monitor interval reference
let memoryMonitorInterval = null;

// Auth sessions directory
const SESSIONS_DIR = path.join(process.cwd(), ".baileys_auth");
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ==================== HELPER FUNCTIONS ====================

// Helper function to get session path
function getSessionPath(accountId) {
  return path.join(SESSIONS_DIR, `session_${accountId}`);
}

// Helper function to update account status
async function updateAccountStatus(accountId, status, data = {}) {
  try {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { status, ...data },
    });
    logger.info(`Updated status for ${accountId}: ${status}`);
  } catch (error) {
    logger.error(`Failed to update status for ${accountId}:`, error);
  }
}

// Calculate exponential backoff delay
function getBackoffDelay(attempt) {
  const delay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, attempt),
    CONFIG.RECONNECT_MAX_DELAY
  );
  // Add jitter to prevent thundering herd
  return delay + Math.random() * 1000;
}

// Generate random delay in range
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Calculate typing delay based on message length
function calculateTypingDelay(message) {
  const length = message.length;
  const speed = randomDelay(CONFIG.TYPING_SPEED_MIN, CONFIG.TYPING_SPEED_MAX);
  return length * speed;
}

// Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check rate limit for account
async function checkRateLimit(accountId) {
  // Get account to check if limits should be applied
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  // If useLimits is false, always allow
  if (!account || !account.useLimits) {
    return { allowed: true, noLimits: true };
  }

  const now = Date.now();

  if (!rateLimiter.has(accountId)) {
    rateLimiter.set(accountId, { count: 0, windowStart: now });
  }

  const limiter = rateLimiter.get(accountId);

  // Reset window if expired
  if (now - limiter.windowStart > CONFIG.RATE_LIMIT_WINDOW) {
    limiter.count = 0;
    limiter.windowStart = now;
  }

  // Check if limit exceeded
  if (limiter.count >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    const resetIn = Math.ceil(
      (limiter.windowStart + CONFIG.RATE_LIMIT_WINDOW - now) / 1000
    );
    return { allowed: false, resetIn };
  }

  limiter.count++;
  return { allowed: true };
}

// Check daily limits
async function checkDailyLimit(accountId) {
  const now = Date.now();
  const today = new Date().toDateString();

  if (!dailyLimits.has(accountId)) {
    dailyLimits.set(accountId, {
      date: today,
      messageCount: 0,
      newChatsCount: 0,
    });
  }

  const limits = dailyLimits.get(accountId);

  // Reset if new day
  if (limits.date !== today) {
    limits.date = today;
    limits.messageCount = 0;
    limits.newChatsCount = 0;
  }

  // Get account creation date to determine limits
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    return { allowed: false, reason: "Account not found" };
  }

  // If useLimits is false, always allow
  if (!account.useLimits) {
    return { allowed: true, isNewAccount: false, noLimits: true };
  }

  const accountAge = Date.now() - new Date(account.createdAt).getTime();
  const isNewAccount = accountAge < 7 * 24 * 60 * 60 * 1000; // 7 days

  const dailyLimit = isNewAccount
    ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
    : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT;

  if (limits.messageCount >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily limit reached (${dailyLimit} messages)`,
      isNewAccount,
    };
  }

  return { allowed: true, isNewAccount };
}

// Check if account needs rest
async function checkNeedRest(accountId) {
  // Get account to check if limits should be applied
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  // If useLimits is false, never rest
  if (!account || !account.useLimits) {
    return { needRest: false, noLimits: true };
  }

  if (!messageCounters.has(accountId)) {
    messageCounters.set(accountId, {
      count: 0,
      lastRest: Date.now(),
      isResting: false,
    });
  }

  const counter = messageCounters.get(accountId);

  if (counter.isResting) {
    return { needRest: true, reason: "Currently resting" };
  }

  if (counter.count >= CONFIG.REST_AFTER_MESSAGES) {
    return { needRest: true, reason: "Need rest after messages" };
  }

  return { needRest: false };
}

// Clean up old client resources
async function cleanupClient(accountId) {
  const clientInfo = clients.get(accountId);
  if (clientInfo && clientInfo.sock) {
    try {
      // Remove all listeners to prevent memory leaks
      clientInfo.sock.ev.removeAllListeners();

      // Close the socket
      await clientInfo.sock.end();

      logger.info(`Cleaned up old socket for ${accountId}`);
    } catch (error) {
      logger.error(`Error cleaning up client ${accountId}:`, error.message);
    }
  }
  clients.delete(accountId);
}

// ==================== RECONNECTION LOGIC ====================

// Reconnect with exponential backoff
async function reconnectWithBackoff(accountId) {
  if (isShuttingDown) return;

  const attempts = reconnectAttempts.get(accountId) || 0;

  if (attempts >= CONFIG.RECONNECT_MAX_RETRIES) {
    logger.error(
      `Max reconnection attempts (${CONFIG.RECONNECT_MAX_RETRIES}) reached for ${accountId}`
    );
    await updateAccountStatus(accountId, "FAILED");
    reconnectAttempts.delete(accountId);
    return;
  }

  const delay = getBackoffDelay(attempts);

  logger.info(
    `Reconnecting ${accountId} in ${Math.round(delay / 1000)}s (attempt ${
      attempts + 1
    }/${CONFIG.RECONNECT_MAX_RETRIES})`
  );

  setTimeout(async () => {
    if (isShuttingDown) return;

    reconnectAttempts.set(accountId, attempts + 1);

    try {
      await initializeClient(accountId);
      // Reset attempts on successful connection
      reconnectAttempts.delete(accountId);
    } catch (error) {
      logger.error(`Reconnection failed for ${accountId}:`, error.message);
      // Schedule next attempt
      await reconnectWithBackoff(accountId);
    }
  }, delay);
}

// ==================== HEARTBEAT SYSTEM ====================

// Start heartbeat monitoring
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(async () => {
    if (isShuttingDown) return;

    for (const [accountId, clientInfo] of clients.entries()) {
      if (clientInfo.status === "CONNECTED") {
        try {
          // Use presence update as a ping mechanism
          const pingStart = Date.now();

          // Set a timeout for the ping
          const pingPromise = clientInfo.sock.sendPresenceUpdate("available");
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Heartbeat timeout")),
              CONFIG.HEARTBEAT_TIMEOUT
            )
          );

          await Promise.race([pingPromise, timeoutPromise]);

          const latency = Date.now() - pingStart;
          clientInfo.lastHeartbeat = Date.now();
          clientInfo.latency = latency;

          logger.debug(`Heartbeat OK for ${accountId} (${latency}ms)`);
        } catch (error) {
          logger.warn(`Heartbeat failed for ${accountId}: ${error.message}`);

          // Mark as disconnected and try to reconnect
          clientInfo.status = "DISCONNECTED";
          await updateAccountStatus(accountId, "DISCONNECTED");

          // Clean up and reconnect
          await cleanupClient(accountId);
          await reconnectWithBackoff(accountId);
        }
      }
    }
  }, CONFIG.HEARTBEAT_INTERVAL);

  logger.info(
    `Heartbeat monitoring started (interval: ${
      CONFIG.HEARTBEAT_INTERVAL / 1000
    }s)`
  );
}

// Stop heartbeat monitoring
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    logger.info("Heartbeat monitoring stopped");
  }
}

// ==================== MEMORY MANAGEMENT ====================

// Start memory pressure monitoring
function startMemoryMonitor() {
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
  }

  memoryMonitorInterval = setInterval(async () => {
    const used = process.memoryUsage();
    const heapPercent = used.heapUsed / used.heapTotal;

    if (heapPercent > CONFIG.MEMORY_CRITICAL_THRESHOLD) {
      logger.error(
        `CRITICAL: Memory usage at ${Math.round(heapPercent * 100)}%`
      );

      // Force garbage collection if available
      if (global.gc) {
        logger.info("Forcing garbage collection...");
        global.gc();
      }

      // Disconnect least active accounts if still critical
      const memAfterGC = process.memoryUsage();
      if (
        memAfterGC.heapUsed / memAfterGC.heapTotal >
        CONFIG.MEMORY_CRITICAL_THRESHOLD
      ) {
        const clientsToDisconnect = Math.ceil(clients.size * 0.2);

        if (clientsToDisconnect > 0 && clients.size > 1) {
          logger.warn(
            `Disconnecting ${clientsToDisconnect} client(s) due to memory pressure`
          );

          // Get clients sorted by last activity (oldest first)
          const sortedClients = Array.from(clients.entries())
            .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0))
            .slice(0, clientsToDisconnect);

          for (const [accountId] of sortedClients) {
            try {
              await cleanupClient(accountId);
              await updateAccountStatus(accountId, "DISCONNECTED");
              logger.info(
                `Auto-disconnected ${accountId} due to memory pressure`
              );
            } catch (error) {
              logger.error(`Failed to disconnect ${accountId}:`, error.message);
            }
          }
        }
      }
    } else if (heapPercent > CONFIG.MEMORY_WARNING_THRESHOLD) {
      logger.warn(`WARNING: Memory usage at ${Math.round(heapPercent * 100)}%`);
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL);

  logger.info("Memory monitoring started");
}

// ==================== MESSAGE QUEUE SYSTEM ====================

// Add message to queue
function enqueueMessage(accountId, to, message) {
  if (!messageQueues.has(accountId)) {
    messageQueues.set(accountId, []);
  }

  const queue = messageQueues.get(accountId);
  const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  queue.push({
    id: messageId,
    to,
    message,
    retries: 0,
    createdAt: Date.now(),
  });

  return messageId;
}

// Send message with human-like behavior
async function sendMessageWithHumanBehavior(accountId, jid, message) {
  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    throw new Error("Client not connected");
  }

  // Check if account uses limits
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  // If no limits, send immediately without delays
  if (account && !account.useLimits) {
    const sentMessage = await clientInfo.sock.sendMessage(jid, {
      text: message,
    });
    logger.info(`Message sent instantly (no limits) to ${jid}`);
    return sentMessage;
  }

  // With limits - use human-like behavior
  // 1. Случайная задержка перед началом печати (думаем, что написать)
  const delayBeforeTyping = randomDelay(
    CONFIG.DELAY_BEFORE_TYPING_MIN,
    CONFIG.DELAY_BEFORE_TYPING_MAX
  );
  logger.debug(`Waiting ${delayBeforeTyping}ms before typing...`);
  await sleep(delayBeforeTyping);

  // 2. Отправляем статус "печатает"
  try {
    await clientInfo.sock.sendPresenceUpdate("composing", jid);
    logger.debug(`Typing indicator sent to ${jid}`);
  } catch (err) {
    logger.warn(`Failed to send typing indicator: ${err.message}`);
  }

  // 3. Эмулируем время печати на основе длины сообщения
  const typingDuration = calculateTypingDelay(message);
  logger.debug(
    `Typing for ${typingDuration}ms (message length: ${message.length})`
  );
  await sleep(typingDuration);

  // 4. Отправляем статус "онлайн" (закончили печатать)
  try {
    await clientInfo.sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    logger.warn(`Failed to send paused status: ${err.message}`);
  }

  // 5. Небольшая задержка перед отправкой (проверяем сообщение)
  await sleep(randomDelay(200, 800));

  // 6. Отправляем сообщение
  const sentMessage = await clientInfo.sock.sendMessage(jid, {
    text: message,
  });

  logger.info(`Message sent with human-like behavior to ${jid}`);
  return sentMessage;
}

// Process message queue for an account with automatic rate limit handling
async function processMessageQueue(accountId) {
  const queue = messageQueues.get(accountId);
  if (!queue || queue.length === 0) {
    logger.debug(`Queue empty for ${accountId}`);
    return;
  }

  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    logger.warn(
      `Client ${accountId} not connected, queue paused (${queue.length} messages waiting)`
    );
    // Retry in 10 seconds
    setTimeout(() => processMessageQueue(accountId), 10000);
    return;
  }

  // Check if need rest
  const restCheck = await checkNeedRest(accountId);
  if (restCheck.needRest) {
    const counter = messageCounters.get(accountId);
    if (!counter.isResting) {
      // Start rest period
      counter.isResting = true;
      const restDuration = randomDelay(
        CONFIG.REST_DURATION_MIN,
        CONFIG.REST_DURATION_MAX
      );
      logger.info(
        `💤 Account ${accountId} taking a break for ${Math.round(
          restDuration / 1000
        )} seconds after ${counter.count} messages (${
          queue.length
        } messages in queue)`
      );

      setTimeout(() => {
        counter.isResting = false;
        counter.count = 0;
        counter.lastRest = Date.now();
        logger.info(
          `✨ Account ${accountId} finished resting, resuming queue...`
        );
        processMessageQueue(accountId);
      }, restDuration);
    }
    return;
  }

  // Check rate limit
  const rateCheck = await checkRateLimit(accountId);
  if (!rateCheck.allowed) {
    logger.warn(
      `⏳ Rate limit reached for ${accountId}. Waiting ${rateCheck.resetIn}s (${queue.length} messages in queue)...`
    );
    // Wait for rate limit reset, then continue
    setTimeout(() => {
      logger.info(`🔄 Rate limit reset for ${accountId}, resuming queue...`);
      processMessageQueue(accountId);
    }, rateCheck.resetIn * 1000);
    return;
  }

  // Check daily limit
  const dailyCheck = await checkDailyLimit(accountId);
  if (!dailyCheck.allowed) {
    logger.error(
      `🚫 Daily limit reached for ${accountId}: ${dailyCheck.reason} (${queue.length} messages in queue)`
    );
    // Check again in 1 hour
    setTimeout(() => {
      logger.info(`🔄 Checking daily limit for ${accountId} again...`);
      processMessageQueue(accountId);
    }, 3600000);
    return;
  }

  const msg = queue[0];

  try {
    // Format JID
    let jid = msg.to;
    if (!msg.to.includes("@")) {
      jid = `${msg.to}@s.whatsapp.net`;
    }

    logger.info(
      `📤 Processing message for ${accountId} to ${msg.to} (${queue.length} in queue)`
    );

    // Send message with human-like behavior
    const sentMessage = await sendMessageWithHumanBehavior(
      accountId,
      jid,
      msg.message
    );

    // Save to database
    await prisma.message.create({
      data: {
        accountId,
        chatId: jid,
        direction: "OUTGOING",
        message: msg.message,
        to: msg.to,
        status: "SENT",
        contactNumber: msg.to,
      },
    });

    // Increment daily counter
    const limits = dailyLimits.get(accountId);
    if (limits) {
      limits.messageCount++;
    }

    // Increment message counter for rest periods
    const counter = messageCounters.get(accountId);
    if (counter) {
      counter.count++;
    }

    // Remove from queue
    queue.shift();

    logger.info(
      `✅ Message sent from ${accountId} to ${msg.to} (Daily: ${
        limits?.messageCount || 0
      }, Session: ${counter ? counter.count : 0}, Queue: ${
        queue.length
      } remaining)`
    );

    // Process next message with random delay (or immediately if no limits)
    if (queue.length > 0) {
      // Check if account has limits
      const account = await prisma.whatsAppAccount.findUnique({
        where: { id: accountId },
      });

      if (account && !account.useLimits) {
        // No limits - process immediately
        logger.debug(`⚡ Processing next message immediately (no limits)...`);
        setTimeout(() => processMessageQueue(accountId), 100);
      } else {
        // With limits - use delay
        const nextDelay = randomDelay(
          CONFIG.DELAY_BETWEEN_MESSAGES_MIN,
          CONFIG.DELAY_BETWEEN_MESSAGES_MAX
        );
        logger.debug(
          `⏱️  Waiting ${Math.round(nextDelay / 1000)}s before next message...`
        );
        setTimeout(() => processMessageQueue(accountId), nextDelay);
      }
    } else {
      logger.info(`🎉 Queue empty for ${accountId}`);
    }

    return sentMessage;
  } catch (error) {
    logger.error(`❌ Failed to send message from ${accountId}:`, error.message);

    msg.retries++;

    if (msg.retries >= CONFIG.MESSAGE_RETRY_COUNT) {
      // Save failed message
      await prisma.message.create({
        data: {
          accountId,
          message: msg.message,
          to: msg.to,
          direction: "OUTGOING",
          status: "FAILED",
          contactNumber: msg.to,
        },
      });

      queue.shift();
      logger.error(
        `🔴 Message permanently failed after ${CONFIG.MESSAGE_RETRY_COUNT} retries, skipping...`
      );

      // Continue with next message
      if (queue.length > 0) {
        setTimeout(() => processMessageQueue(accountId), 2000);
      }
    } else {
      // Retry later
      logger.info(
        `🔄 Retrying message (attempt ${msg.retries + 1}/${
          CONFIG.MESSAGE_RETRY_COUNT
        })`
      );
      setTimeout(
        () => processMessageQueue(accountId),
        CONFIG.MESSAGE_RETRY_DELAY
      );
    }
  }
}

// ==================== CONTRACT PROCESSING ====================

// Process contract - send messages to all recipients
async function processContract(contractId) {
  if (isShuttingDown) return;

  const contractInfo = activeContracts.get(contractId);
  if (!contractInfo) {
    logger.error(`Contract ${contractId} not found in active contracts`);
    return;
  }

  try {
    // Get contract from database
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        recipients: {
          where: { status: { in: ['PENDING', 'FAILED'] } },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!contract) {
      logger.error(`Contract ${contractId} not found in database`);
      activeContracts.delete(contractId);
      return;
    }

    const accountId = contract.accountId;
    const clientInfo = clients.get(accountId);

    if (!clientInfo || clientInfo.status !== 'CONNECTED') {
      logger.warn(`Client ${accountId} not connected, pausing contract ${contractId}`);
      await prisma.contract.update({
        where: { id: contractId },
        data: { status: 'PAUSED' }
      });
      contractInfo.status = 'PAUSED';
      return;
    }

    // Update contract status to IN_PROGRESS
    if (contract.status === 'PENDING') {
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date()
        }
      });
    }

    logger.info(`📋 Processing contract ${contract.name} (${contractId}): ${contract.recipients.length} recipients pending`);

    // Process each recipient
    for (const recipient of contract.recipients) {
      if (isShuttingDown || contractInfo.status === 'PAUSED') {
        logger.info(`Contract ${contractId} paused or shutting down`);
        break;
      }

      try {
        // Update recipient status to QUEUED
        await prisma.contractRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'QUEUED',
            attempts: recipient.attempts + 1,
            lastAttempt: new Date()
          }
        });

        // Check rate limit
        const rateCheck = await checkRateLimit(accountId);
        if (!rateCheck.allowed) {
          logger.warn(`⏳ Rate limit reached for contract ${contractId}. Waiting ${rateCheck.resetIn}s...`);
          await sleep(rateCheck.resetIn * 1000);
        }

        // Check daily limit
        const dailyCheck = await checkDailyLimit(accountId);
        if (!dailyCheck.allowed) {
          logger.error(`🚫 Daily limit reached for contract ${contractId}: ${dailyCheck.reason}`);
          await prisma.contract.update({
            where: { id: contractId },
            data: { status: 'PAUSED' }
          });
          contractInfo.status = 'PAUSED';
          break;
        }

        // Check if need rest
        const restCheck = await checkNeedRest(accountId);
        if (restCheck.needRest && !restCheck.noLimits) {
          const counter = messageCounters.get(accountId);
          if (!counter.isResting) {
            counter.isResting = true;
            const restDuration = randomDelay(CONFIG.REST_DURATION_MIN, CONFIG.REST_DURATION_MAX);
            logger.info(`💤 Contract ${contractId} taking a break for ${Math.round(restDuration / 1000)}s after ${counter.count} messages`);

            await sleep(restDuration);

            counter.isResting = false;
            counter.count = 0;
            counter.lastRest = Date.now();
            logger.info(`✨ Contract ${contractId} resuming after rest...`);
          }
        }

        // Update recipient status to SENDING
        await prisma.contractRecipient.update({
          where: { id: recipient.id },
          data: { status: 'SENDING' }
        });

        // Format JID
        let jid = recipient.phoneNumber;
        if (!jid.includes('@')) {
          jid = `${jid}@s.whatsapp.net`;
        }

        logger.info(`📤 Sending to ${recipient.phoneNumber} (Contract: ${contract.name})`);

        // Send message with human-like behavior
        const sentMessage = await sendMessageWithHumanBehavior(
          accountId,
          jid,
          recipient.message
        );

        // Save to database
        const dbMessage = await prisma.message.create({
          data: {
            accountId,
            chatId: jid,
            direction: 'OUTGOING',
            message: recipient.message,
            to: recipient.phoneNumber,
            status: 'SENT',
            contactNumber: recipient.phoneNumber,
          }
        });

        // Update recipient status to SUCCESS
        await prisma.contractRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'SUCCESS',
            messageId: dbMessage.id,
            sentAt: new Date()
          }
        });

        // Update contract counters
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            successCount: { increment: 1 },
            pendingCount: { decrement: 1 }
          }
        });

        // Increment daily counter
        const limits = dailyLimits.get(accountId);
        if (limits) {
          limits.messageCount++;
        }

        // Increment message counter for rest periods
        const counter = messageCounters.get(accountId);
        if (counter) {
          counter.count++;
        }

        logger.info(`✅ SUCCESS: ${recipient.phoneNumber} (Contract: ${contract.name})`);

        // Get account to check if limits should be applied
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId }
        });

        // Add delay between messages if limits are enabled
        if (account && account.useLimits) {
          const nextDelay = randomDelay(
            CONFIG.DELAY_BETWEEN_MESSAGES_MIN,
            CONFIG.DELAY_BETWEEN_MESSAGES_MAX
          );
          logger.debug(`⏱️  Waiting ${Math.round(nextDelay / 1000)}s before next message...`);
          await sleep(nextDelay);
        } else {
          // Small delay even without limits to prevent overwhelming
          await sleep(100);
        }

      } catch (error) {
        logger.error(`❌ FAILED: ${recipient.phoneNumber} - ${error.message}`);

        // Update recipient status to FAILED
        await prisma.contractRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'FAILED',
            errorMessage: error.message
          }
        });

        // Update contract counters
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            failureCount: { increment: 1 },
            pendingCount: { decrement: 1 }
          }
        });

        // Continue with next recipient after short delay
        await sleep(2000);
      }
    }

    // Check if contract is completed
    const updatedContract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        recipients: {
          where: { status: { in: ['PENDING', 'QUEUED', 'SENDING'] } }
        }
      }
    });

    if (updatedContract.recipients.length === 0) {
      // Contract completed
      await prisma.contract.update({
        where: { id: contractId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date()
        }
      });

      logger.info(`🎉 CONTRACT COMPLETED: ${contract.name}`);
      logger.info(`   ✅ Success: ${updatedContract.successCount}`);
      logger.info(`   ❌ Failed: ${updatedContract.failureCount}`);

      activeContracts.delete(contractId);
    } else {
      logger.info(`⏸️  Contract ${contractId} paused with ${updatedContract.recipients.length} pending`);
    }

  } catch (error) {
    logger.error(`Error processing contract ${contractId}:`, error);

    await prisma.contract.update({
      where: { id: contractId },
      data: { status: 'FAILED' }
    });

    activeContracts.delete(contractId);
  }
}

// ==================== WHATSAPP CLIENT INITIALIZATION ====================

// Initialize WhatsApp client with Baileys
async function initializeClient(accountId) {
  if (isShuttingDown) {
    throw new Error("Server is shutting down");
  }

  // Check for race condition
  if (connectingAccounts.has(accountId)) {
    throw new Error("Client is already being initialized");
  }

  logger.info(`Initializing Baileys client for ${accountId}`);

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error("Account not found");
  }

  // Check if client already exists and connected
  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === "CONNECTED") {
      throw new Error("Client already connected");
    }
    // Clean up existing client
    await cleanupClient(accountId);
  }

  // Mark as connecting to prevent race conditions
  connectingAccounts.add(accountId);

  const sessionPath = getSessionPath(accountId);

  // Create session directory if it doesn't exist
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  try {
    await updateAccountStatus(accountId, "CONNECTING");

    // Get latest Baileys version
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using Baileys version: ${version.join(".")}`);

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Create socket with optimized settings for long-term stability
    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }), // Silent logger for socket
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: "silent" })
        ),
      },
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      browser: ["OCTO WhatsApp Manager", "Chrome", "120.0.0"],
      // Connection settings for stability
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000, // Send keep-alive every 25 seconds
      retryRequestDelayMs: 500,
      qrTimeout: 60000,
      // Message retry settings
      getMessage: async key => {
        // Return empty for now, can be enhanced to fetch from DB
        return { conversation: "" };
      },
    });

    const clientInfo = {
      accountId,
      sock,
      status: "CONNECTING",
      qrCode: null,
      phoneNumber: null,
      lastActivity: Date.now(),
      lastHeartbeat: null,
      latency: null,
    };

    clients.set(accountId, clientInfo);

    // Set initialization timeout
    const initTimeout = setTimeout(async () => {
      if (clientInfo.status !== "CONNECTED") {
        logger.error(`Initialization timeout for ${accountId}`);
        await cleanupClient(accountId);
        connectingAccounts.delete(accountId);
        await updateAccountStatus(accountId, "FAILED");
      }
    }, CONFIG.INIT_TIMEOUT);

    // Handle connection updates
    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          clientInfo.qrCode = qrDataUrl;
          clientInfo.status = "QR_READY";
          await updateAccountStatus(accountId, "QR_READY", {
            qrCode: qrDataUrl,
          });
          logger.info(`QR code generated for ${accountId}`);
        } catch (error) {
          logger.error(`Failed to generate QR for ${accountId}:`, error);
        }
      }

      // Handle connection status
      if (connection === "close") {
        clearTimeout(initTimeout);
        connectingAccounts.delete(accountId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.info(
          `Connection closed for ${accountId}. Status: ${statusCode}, Reconnect: ${shouldReconnect}`
        );

        // Clean up current client
        await cleanupClient(accountId);

        if (shouldReconnect && !isShuttingDown) {
          // Use exponential backoff for reconnection
          await reconnectWithBackoff(accountId);
        } else {
          await updateAccountStatus(accountId, "DISCONNECTED");
          reconnectAttempts.delete(accountId);

          // Clean up auth if logged out
          if (statusCode === DisconnectReason.loggedOut) {
            logger.info(`User logged out, cleaning auth for ${accountId}`);
            try {
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }
            } catch (err) {
              logger.error(`Failed to clean auth for ${accountId}:`, err);
            }
          }
        }
      } else if (connection === "open") {
        clearTimeout(initTimeout);
        connectingAccounts.delete(accountId);

        logger.info(`Connection opened for ${accountId}`);
        clientInfo.status = "CONNECTED";
        clientInfo.qrCode = null;
        clientInfo.lastActivity = Date.now();
        clientInfo.lastHeartbeat = Date.now();

        // Reset reconnection attempts on successful connection
        reconnectAttempts.delete(accountId);

        // Get phone number
        const phoneNumber = sock.user?.id?.split(":")[0] || null;
        clientInfo.phoneNumber = phoneNumber;

        await updateAccountStatus(accountId, "CONNECTED", {
          phoneNumber,
          qrCode: null,
        });

        // Process any queued messages
        processMessageQueue(accountId).catch(err => {
          logger.error(
            `Error processing message queue for ${accountId}:`,
            err.message
          );
        });
      } else if (connection === "connecting") {
        logger.info(`Connecting ${accountId}...`);
        clientInfo.status = "AUTHENTICATING";
        await updateAccountStatus(accountId, "AUTHENTICATING");
      }
    });

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages and save to database
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type === "notify") {
        clientInfo.lastActivity = Date.now();

        for (const msg of messages) {
          try {
            const messageText =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              "";

            if (!messageText) continue;

            const chatId = msg.key.remoteJid;
            const contactNumber = chatId.split("@")[0];
            const isFromMe = msg.key.fromMe;

            // Save to database
            await prisma.message.create({
              data: {
                accountId,
                chatId,
                direction: isFromMe ? "OUTGOING" : "INCOMING",
                message: messageText,
                to: isFromMe ? contactNumber : null,
                from: isFromMe ? null : contactNumber,
                status: isFromMe ? "SENT" : "RECEIVED",
                contactNumber,
                contactName: msg.pushName || null,
              },
            });

            logger.info(
              `Saved ${
                isFromMe ? "outgoing" : "incoming"
              } message for ${accountId}`
            );
          } catch (error) {
            logger.error(`Failed to save message for ${accountId}:`, error);
          }
        }
      }
    });

    // Handle message status updates
    sock.ev.on("messages.update", async updates => {
      clientInfo.lastActivity = Date.now();

      for (const update of updates) {
        try {
          if (update.update.status) {
            const statusMap = {
              1: "PENDING",
              2: "SENT",
              3: "DELIVERED",
              4: "READ",
            };

            const newStatus = statusMap[update.update.status];
            if (newStatus) {
              logger.debug(
                `Message ${update.key.id} status updated to ${newStatus}`
              );
            }
          }
        } catch (error) {
          logger.error(`Failed to handle message update:`, error);
        }
      }
    });

    // Handle presence updates (typing, online, etc.)
    sock.ev.on("presence.update", async update => {
      clientInfo.lastActivity = Date.now();
      logger.debug(
        `Presence update: ${update.id} is ${
          update.presences?.[update.id]?.lastKnownPresence
        }`
      );
    });

    // Handle errors
    sock.ev.on("error", async error => {
      logger.error(`Socket error for ${accountId}:`, error);
      clientInfo.lastActivity = Date.now();
    });
  } catch (error) {
    connectingAccounts.delete(accountId);
    logger.error(`Failed to initialize client for ${accountId}:`, error);
    await updateAccountStatus(accountId, "FAILED");
    await cleanupClient(accountId);
    throw error;
  }
}

// ==================== API ROUTES ====================

// Get all accounts
app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await prisma.whatsAppAccount.findMany({
      orderBy: { createdAt: "desc" },
    });

    const accountsWithClientStatus = accounts.map(account => {
      const clientStatus = clients.get(account.id);
      return {
        ...account,
        clientStatus: clientStatus?.status || account.status,
        hasActiveClient: !!clientStatus,
        lastHeartbeat: clientStatus?.lastHeartbeat || null,
        latency: clientStatus?.latency || null,
      };
    });

    res.json(accountsWithClientStatus);
  } catch (error) {
    logger.error("Failed to load accounts:", error);
    res.status(500).json({ error: error.message });
  }
});

// Create account
app.post("/api/accounts", async (req, res) => {
  try {
    const { name, useLimits = true } = req.body;
    const account = await prisma.whatsAppAccount.create({
      data: { name, useLimits },
    });
    logger.info(`Created account: ${account.id} (${name}) - useLimits: ${useLimits}`);
    res.status(201).json(account);
  } catch (error) {
    logger.error("Failed to create account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get account by ID
app.get("/api/accounts/:id", async (req, res) => {
  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const clientStatus = clients.get(req.params.id);
    res.json({
      ...account,
      clientStatus: clientStatus?.status || account.status,
      hasActiveClient: !!clientStatus,
      lastHeartbeat: clientStatus?.lastHeartbeat || null,
      latency: clientStatus?.latency || null,
    });
  } catch (error) {
    logger.error("Failed to get account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update account
app.put("/api/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, useLimits } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (useLimits !== undefined) updateData.useLimits = useLimits;

    const account = await prisma.whatsAppAccount.update({
      where: { id },
      data: updateData,
    });

    logger.info(`Updated account: ${id} - ${JSON.stringify(updateData)}`);
    res.json(account);
  } catch (error) {
    logger.error("Failed to update account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Connect account
app.post("/api/accounts/:id/connect", async (req, res) => {
  try {
    const accountId = req.params.id;

    // Check if already connecting
    if (connectingAccounts.has(accountId)) {
      return res
        .status(400)
        .json({ error: "Client is already being initialized" });
    }

    // Check if already connected
    const existing = clients.get(accountId);
    if (existing && existing.status === "CONNECTED") {
      return res.status(400).json({ error: "Client already connected" });
    }

    await initializeClient(accountId);
    res.json({ success: true, message: "Client initialization started" });
  } catch (error) {
    logger.error("Failed to connect:", error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect account
app.post("/api/accounts/:id/disconnect", async (req, res) => {
  try {
    const accountId = req.params.id;
    const clientInfo = clients.get(accountId);

    if (!clientInfo) {
      return res.status(404).json({ error: "Client not found" });
    }

    // Stop reconnection attempts
    reconnectAttempts.delete(accountId);

    // Close the socket
    try {
      await clientInfo.sock.logout();
    } catch (e) {
      // Ignore logout errors, just clean up
    }

    await cleanupClient(accountId);
    await updateAccountStatus(accountId, "DISCONNECTED");

    logger.info(`Disconnected client: ${accountId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to disconnect:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete account
app.delete("/api/accounts/:id", async (req, res) => {
  try {
    const accountId = req.params.id;

    // Stop reconnection attempts
    reconnectAttempts.delete(accountId);

    const clientInfo = clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.sock.logout();
      } catch (e) {
        logger.error("Error during logout:", e);
      }
      await cleanupClient(accountId);
    }

    // Delete session files
    const sessionPath = getSessionPath(accountId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Clear message queue
    messageQueues.delete(accountId);
    rateLimiter.delete(accountId);

    await prisma.whatsAppAccount.delete({
      where: { id: accountId },
    });

    logger.info(`Deleted account: ${accountId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Send message - always queues message for automatic processing
app.post("/api/messages/send", async (req, res) => {
  try {
    const { accountId, to, message } = req.body;

    if (!accountId || !to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const clientInfo = clients.get(accountId);
    if (!clientInfo) {
      return res.status(400).json({ error: "Client not initialized" });
    }

    // Get current queue status
    const queue = messageQueues.get(accountId) || [];
    const queueLength = queue.length;

    // Always add to queue (система сама обработает с учетом лимитов)
    const messageId = enqueueMessage(accountId, to, message);

    logger.info(
      `📥 Message queued for ${accountId} to ${to} (Queue: ${
        queueLength + 1
      } messages)`
    );

    // Start queue processing if not already running
    // Проверяем, есть ли уже активная обработка очереди
    if (queueLength === 0) {
      logger.info(`🚀 Starting queue processor for ${accountId}`);
      // Запускаем обработку через небольшую задержку
      setTimeout(() => processMessageQueue(accountId), 100);
    }

    // Получаем информацию о лимитах
    const dailyCheck = await checkDailyLimit(accountId);
    const limitsInfo = dailyLimits.get(accountId);

    res.status(202).json({
      success: true,
      queued: true,
      messageId,
      queuePosition: queueLength + 1,
      queueLength: queueLength + 1,
      message: "Message queued for automatic delivery",
      status: clientInfo.status,
      dailyCount: limitsInfo?.messageCount || 0,
      dailyLimit: dailyCheck.isNewAccount
        ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
        : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT,
    });
  } catch (error) {
    logger.error("Failed to queue message:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get chats for an account
app.get("/api/accounts/:id/chats", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50, phone } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where = {
      accountId: id,
    };

    // Filter by phone if provided
    if (phone) {
      where.OR = [
        { to: { contains: phone } },
        { from: { contains: phone } },
        { contactNumber: { contains: phone } },
      ];
    }

    // Get all messages grouped by chat
    const messages = await prisma.message.findMany({
      where,
      orderBy: { sentAt: "desc" },
    });

    // Group messages by contactNumber or chatId
    const chatsMap = new Map();

    messages.forEach(msg => {
      const key = msg.contactNumber || msg.to || msg.from || msg.chatId;
      if (!key) return;

      if (!chatsMap.has(key)) {
        chatsMap.set(key, {
          chatId: msg.chatId,
          contactNumber: msg.contactNumber || msg.to || msg.from,
          contactName: msg.contactName,
          messages: [],
          unreadCount: 0,
          lastMessageTime: msg.sentAt,
        });
      }

      const chat = chatsMap.get(key);
      chat.messages.push(msg);

      // Update last message time if newer
      if (new Date(msg.sentAt) > new Date(chat.lastMessageTime)) {
        chat.lastMessageTime = msg.sentAt;
      }
    });

    // Convert map to array and sort by last message time
    let chatsArray = Array.from(chatsMap.values());
    chatsArray.sort(
      (a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime)
    );

    // Apply pagination
    const total = chatsArray.length;
    const paginatedChats = chatsArray.slice(skip, skip + limitNum);

    const totalPages = Math.ceil(total / limitNum);

    res.json({
      data: paginatedChats,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    logger.error("Failed to get chats:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific chat
app.get("/api/accounts/:accountId/chats/:chatId", async (req, res) => {
  try {
    const { accountId, chatId } = req.params;
    const decodedChatId = decodeURIComponent(chatId);

    const messages = await prisma.message.findMany({
      where: {
        accountId,
        chatId: decodedChatId,
      },
      orderBy: { sentAt: "asc" },
    });

    res.json(messages);
  } catch (error) {
    logger.error("Failed to get chat messages:", error);
    res.status(500).json({ error: error.message });
  }
});

// Send message to a specific chat - always queues message
app.post("/api/accounts/:accountId/chats/:chatId", async (req, res) => {
  try {
    const { accountId, chatId } = req.params;
    const { message } = req.body;
    const decodedChatId = decodeURIComponent(chatId);

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const clientInfo = clients.get(accountId);
    if (!clientInfo) {
      return res.status(400).json({ error: "Client not initialized" });
    }

    // Extract contact number from chatId
    const contactNumber = decodedChatId.split("@")[0];

    // Get current queue status
    const queue = messageQueues.get(accountId) || [];
    const queueLength = queue.length;

    // Always add to queue
    const messageId = enqueueMessage(accountId, contactNumber, message);

    logger.info(
      `📥 Message queued for ${accountId} to chat ${decodedChatId} (Queue: ${
        queueLength + 1
      })`
    );

    // Start queue processing if not already running
    if (queueLength === 0) {
      logger.info(`🚀 Starting queue processor for ${accountId}`);
      setTimeout(() => processMessageQueue(accountId), 100);
    }

    // Get limits info
    const dailyCheck = await checkDailyLimit(accountId);
    const limitsInfo = dailyLimits.get(accountId);

    res.status(202).json({
      success: true,
      queued: true,
      messageId,
      queuePosition: queueLength + 1,
      queueLength: queueLength + 1,
      message: "Message queued for automatic delivery",
      status: clientInfo.status,
      dailyCount: limitsInfo?.messageCount || 0,
      dailyLimit: dailyCheck.isNewAccount
        ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
        : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT,
    });
  } catch (error) {
    logger.error("Failed to queue chat message:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get queue status for an account
app.get("/api/accounts/:id/queue", async (req, res) => {
  try {
    const { id } = req.params;

    const queue = messageQueues.get(id) || [];
    const counter = messageCounters.get(id);
    const limitsInfo = dailyLimits.get(id);
    const clientInfo = clients.get(id);

    const dailyCheck = await checkDailyLimit(id);

    res.json({
      accountId: id,
      queueLength: queue.length,
      messages: queue.map((msg, index) => ({
        position: index + 1,
        to: msg.to,
        message:
          msg.message.substring(0, 50) + (msg.message.length > 50 ? "..." : ""),
        retries: msg.retries,
        createdAt: new Date(msg.createdAt).toISOString(),
      })),
      status: {
        clientStatus: clientInfo?.status || "DISCONNECTED",
        isResting: counter?.isResting || false,
        messagesSinceRest: counter?.count || 0,
        restThreshold: CONFIG.REST_AFTER_MESSAGES,
      },
      limits: {
        dailyCount: limitsInfo?.messageCount || 0,
        dailyLimit: dailyCheck.isNewAccount
          ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
          : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT,
        isNewAccount: dailyCheck.isNewAccount,
      },
    });
  } catch (error) {
    logger.error("Failed to get queue status:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONTRACT API ROUTES ====================

// Create a new contract
app.post("/api/contracts", async (req, res) => {
  try {
    const { accountId, name, recipients } = req.body;

    if (!accountId || !name || !recipients || !Array.isArray(recipients)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: "Recipients array cannot be empty" });
    }

    // Validate recipients format
    for (const recipient of recipients) {
      if (!recipient.phoneNumber || !recipient.message) {
        return res.status(400).json({
          error: "Each recipient must have phoneNumber and message"
        });
      }
    }

    // Check if account exists
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId }
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Create contract with recipients
    const contract = await prisma.contract.create({
      data: {
        accountId,
        name,
        totalCount: recipients.length,
        pendingCount: recipients.length,
        status: 'PENDING',
        recipients: {
          create: recipients.map(r => ({
            phoneNumber: r.phoneNumber,
            message: r.message,
            status: 'PENDING'
          }))
        }
      },
      include: {
        recipients: true
      }
    });

    logger.info(`Created contract: ${contract.name} (${contract.id}) with ${recipients.length} recipients`);

    res.status(201).json(contract);
  } catch (error) {
    logger.error("Failed to create contract:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get all contracts
app.get("/api/contracts", async (req, res) => {
  try {
    const { accountId, status } = req.query;

    const where = {};
    if (accountId) where.accountId = accountId;
    if (status) where.status = status;

    const contracts = await prisma.contract.findMany({
      where,
      include: {
        account: {
          select: { id: true, name: true, phoneNumber: true }
        },
        _count: {
          select: { recipients: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(contracts);
  } catch (error) {
    logger.error("Failed to get contracts:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get contract by ID with full details
app.get("/api/contracts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        account: {
          select: { id: true, name: true, phoneNumber: true }
        },
        recipients: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    res.json(contract);
  } catch (error) {
    logger.error("Failed to get contract:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start/Resume contract processing
app.post("/api/contracts/:id/start", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        recipients: {
          where: { status: { in: ['PENDING', 'FAILED'] } }
        }
      }
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    if (contract.status === 'COMPLETED') {
      return res.status(400).json({ error: "Contract already completed" });
    }

    if (contract.recipients.length === 0) {
      return res.status(400).json({ error: "No pending recipients to process" });
    }

    // Check if account is connected
    const clientInfo = clients.get(contract.accountId);
    if (!clientInfo || clientInfo.status !== 'CONNECTED') {
      return res.status(400).json({ error: "Account not connected" });
    }

    // Update contract status
    await prisma.contract.update({
      where: { id },
      data: { status: 'IN_PROGRESS' }
    });

    // Add to active contracts
    activeContracts.set(id, {
      contractId: id,
      status: 'IN_PROGRESS',
      startedAt: Date.now()
    });

    // Start processing in background
    processContract(id).catch(err => {
      logger.error(`Error in contract processing ${id}:`, err);
    });

    logger.info(`Started contract processing: ${contract.name} (${id})`);

    res.json({
      success: true,
      message: "Contract processing started",
      contractId: id,
      pendingRecipients: contract.recipients.length
    });
  } catch (error) {
    logger.error("Failed to start contract:", error);
    res.status(500).json({ error: error.message });
  }
});

// Pause contract processing
app.post("/api/contracts/:id/pause", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id }
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    if (contract.status !== 'IN_PROGRESS') {
      return res.status(400).json({ error: "Contract is not in progress" });
    }

    // Update contract status
    await prisma.contract.update({
      where: { id },
      data: { status: 'PAUSED' }
    });

    // Update active contract
    const contractInfo = activeContracts.get(id);
    if (contractInfo) {
      contractInfo.status = 'PAUSED';
    }

    logger.info(`Paused contract: ${contract.name} (${id})`);

    res.json({
      success: true,
      message: "Contract paused"
    });
  } catch (error) {
    logger.error("Failed to pause contract:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get contract statistics
app.get("/api/contracts/:id/stats", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        recipients: true
      }
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    // Group recipients by status
    const successRecipients = contract.recipients.filter(r => r.status === 'SUCCESS');
    const failedRecipients = contract.recipients.filter(r => r.status === 'FAILED');
    const pendingRecipients = contract.recipients.filter(r =>
      ['PENDING', 'QUEUED', 'SENDING'].includes(r.status)
    );

    const stats = {
      contractId: id,
      name: contract.name,
      status: contract.status,
      total: contract.totalCount,
      success: contract.successCount,
      failed: contract.failureCount,
      pending: pendingRecipients.length,

      successRate: contract.totalCount > 0
        ? ((contract.successCount / contract.totalCount) * 100).toFixed(2) + '%'
        : '0%',

      successPhoneNumbers: successRecipients.map(r => ({
        phoneNumber: r.phoneNumber,
        sentAt: r.sentAt
      })),

      failedPhoneNumbers: failedRecipients.map(r => ({
        phoneNumber: r.phoneNumber,
        errorMessage: r.errorMessage,
        attempts: r.attempts
      })),

      pendingPhoneNumbers: pendingRecipients.map(r => ({
        phoneNumber: r.phoneNumber,
        status: r.status
      })),

      duration: contract.startedAt
        ? Math.round((new Date() - new Date(contract.startedAt)) / 1000) + 's'
        : null,

      createdAt: contract.createdAt,
      startedAt: contract.startedAt,
      completedAt: contract.completedAt
    };

    res.json(stats);
  } catch (error) {
    logger.error("Failed to get contract stats:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete contract
app.delete("/api/contracts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id }
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    // Pause if in progress
    if (contract.status === 'IN_PROGRESS') {
      const contractInfo = activeContracts.get(id);
      if (contractInfo) {
        contractInfo.status = 'PAUSED';
      }
      activeContracts.delete(id);
    }

    // Delete contract (recipients will be deleted by cascade)
    await prisma.contract.delete({
      where: { id }
    });

    logger.info(`Deleted contract: ${contract.name} (${id})`);

    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete contract:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint with detailed status
app.get("/health", (req, res) => {
  const used = process.memoryUsage();

  const health = {
    status: isShuttingDown ? "shutting_down" : "ok",
    uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    activeClients: clients.size,
    connectingClients: connectingAccounts.size,
    clients: Array.from(clients.entries()).map(([id, info]) => ({
      accountId: id,
      status: info.status,
      hasPhone: !!info.phoneNumber,
      lastHeartbeat: info.lastHeartbeat
        ? new Date(info.lastHeartbeat).toISOString()
        : null,
      latency: info.latency,
      lastActivity: info.lastActivity
        ? new Date(info.lastActivity).toISOString()
        : null,
    })),
    memory: {
      heapUsed: Math.round(used.heapUsed / 1024 / 1024),
      heapTotal: Math.round(used.heapTotal / 1024 / 1024),
      heapPercent: Math.round((used.heapUsed / used.heapTotal) * 100),
      rss: Math.round(used.rss / 1024 / 1024),
    },
    reconnections: Object.fromEntries(reconnectAttempts),
  };

  res.json(health);
});

// Format uptime to human readable
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

// ==================== SERVER LIFECYCLE ====================

// Restore connected clients on server start
async function restoreConnectedClients() {
  try {
    const connectedAccounts = await prisma.whatsAppAccount.findMany({
      where: {
        status: "CONNECTED",
      },
    });

    if (connectedAccounts.length === 0) {
      logger.info("No accounts to restore");
      return;
    }

    logger.info(
      `Auto-restoring ${connectedAccounts.length} connected account(s)...`
    );

    // Restore with staggered delays to prevent overwhelming
    for (let i = 0; i < connectedAccounts.length; i++) {
      const account = connectedAccounts[i];

      // Add delay between restores (2 seconds between each)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      try {
        logger.info(`Restoring: ${account.name} (${account.id})`);
        await initializeClient(account.id);
      } catch (error) {
        logger.error(`Failed to restore ${account.name}:`, error.message);
      }
    }

    logger.info(
      `Auto-restore completed for ${connectedAccounts.length} account(s)`
    );
  } catch (error) {
    logger.error("Failed to restore connected clients:", error.message);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop monitoring
  stopHeartbeat();
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
  }

  // Close all WhatsApp clients
  const shutdownPromises = [];

  for (const [accountId, clientInfo] of clients.entries()) {
    logger.info(`Closing client for ${accountId}...`);

    const promise = (async () => {
      try {
        clientInfo.sock.ev.removeAllListeners();
        await clientInfo.sock.end();
        logger.info(`Client ${accountId} closed`);
      } catch (error) {
        logger.error(`Failed to close client ${accountId}:`, error.message);
      }
    })();

    shutdownPromises.push(promise);
  }

  // Wait for all clients to close (with timeout)
  await Promise.race([
    Promise.all(shutdownPromises),
    new Promise(resolve => setTimeout(resolve, 10000)), // 10s timeout
  ]);

  // Close database connection
  await prisma.$disconnect();
  logger.info("Database disconnected");

  // Exit
  logger.info("Shutdown complete");
  process.exit(0);
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", error => {
  logger.error("Uncaught exception:", error);
  // Don't exit, try to recover
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled rejection:", reason);
  // Don't exit, try to recover
});

// Monitor resources
setInterval(() => {
  const used = process.memoryUsage();
  logger.info(
    {
      activeClients: clients.size,
      connectingClients: connectingAccounts.size,
      memoryUsedMB: Math.round(used.heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(used.heapTotal / 1024 / 1024),
      memoryPercent: Math.round((used.heapUsed / used.heapTotal) * 100),
      rssMB: Math.round(used.rss / 1024 / 1024),
      uptimeMinutes: Math.round(process.uptime() / 60),
      reconnectAttempts: reconnectAttempts.size,
    },
    "Resource Monitor"
  );
}, CONFIG.RESOURCE_MONITOR_INTERVAL);

// ==================== SERVER START ====================

const PORT = process.env.API_PORT || 5001;
const server = app.listen(PORT, async () => {
  logger.info(`WhatsApp API Server running on http://localhost:${PORT}`);
  logger.info(`Using Baileys - Pure WhatsApp Web API`);
  logger.info(
    `Configuration: Max retries=${CONFIG.RECONNECT_MAX_RETRIES}, Heartbeat=${
      CONFIG.HEARTBEAT_INTERVAL / 1000
    }s`
  );

  // Reset intermediate states to DISCONNECTED
  try {
    const updated = await prisma.whatsAppAccount.updateMany({
      where: {
        status: {
          in: ["CONNECTING", "QR_READY", "AUTHENTICATING"],
        },
      },
      data: {
        status: "DISCONNECTED",
        qrCode: null,
      },
    });

    if (updated.count > 0) {
      logger.info(`Reset ${updated.count} stuck account(s) to DISCONNECTED`);
    }
  } catch (error) {
    if (error.code === "P2021") {
      logger.warn("Database tables not found. Run migrations first");
    } else {
      logger.error("Failed to reset accounts:", error.message);
    }
  }

  // Start monitoring systems
  startHeartbeat();
  startMemoryMonitor();

  // Auto-restore connected clients
  await restoreConnectedClients();

  logger.info("Ready to accept connections");
  logger.info(`Health check: http://localhost:${PORT}/health`);
});
