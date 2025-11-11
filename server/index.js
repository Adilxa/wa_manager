const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// Store active WhatsApp clients
const clients = new Map();

// Graceful shutdown flag
let isShuttingDown = false;

// Helper function to clean lock files
function cleanLockFiles() {
  const authDir = '.wwebjs_auth';
  const cacheDir = '.wwebjs_cache';

  console.log('🧹 Cleaning Chromium lock files...');

  [authDir, cacheDir].forEach(dir => {
    if (fs.existsSync(dir)) {
      const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

      function removeLocks(directory) {
        const files = fs.readdirSync(directory, { withFileTypes: true });

        files.forEach(file => {
          const fullPath = path.join(directory, file.name);

          if (file.isDirectory()) {
            removeLocks(fullPath);
          } else if (lockFiles.includes(file.name)) {
            try {
              fs.unlinkSync(fullPath);
              console.log(`  Removed: ${fullPath}`);
            } catch (err) {
              console.warn(`  Failed to remove ${fullPath}:`, err.message);
            }
          }
        });
      }

      removeLocks(dir);
    }
  });

  console.log('✅ Lock files cleaned\n');
}

// Helper function to update account status
async function updateAccountStatus(accountId, status, data = {}) {
  try {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { status, ...data },
    });
  } catch (error) {
    console.error(`Failed to update status for ${accountId}:`, error);
  }
}

// Initialize WhatsApp client for an account with retry logic
async function initializeClient(accountId, retryCount = 0) {
  const MAX_RETRIES = 2;

  if (isShuttingDown) {
    throw new Error('Server is shutting down');
  }

  console.log(`Initializing client for ${accountId}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error('Account not found');
  }

  // Check if client already exists
  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === 'CONNECTED' || existing.status === 'CONNECTING') {
      throw new Error('Client already initialized');
    }
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-session-crashed-bubble',
        '--disable-features=ProcessPerSiteUpToMainFrameThreshold',
        '--disable-crash-reporter',
        '--no-crash-upload',
      ],
    },
  });

  const clientInfo = {
    accountId,
    client,
    status: 'CONNECTING',
  };

  clients.set(accountId, clientInfo);
  await updateAccountStatus(accountId, 'CONNECTING');

  // Handle QR code
  client.on('qr', async (qr) => {
    console.log(`QR Code received for ${accountId}`);
    try {
      const qrDataUrl = await QRCode.toDataURL(qr);
      clientInfo.qrCode = qrDataUrl;
      clientInfo.status = 'QR_READY';
      await updateAccountStatus(accountId, 'QR_READY', { qrCode: qrDataUrl });
    } catch (error) {
      console.error(`Failed to generate QR for ${accountId}:`, error);
    }
  });

  // Handle authentication
  client.on('authenticated', async () => {
    console.log(`Client authenticated for ${accountId}`);
    clientInfo.status = 'AUTHENTICATING';
    await updateAccountStatus(accountId, 'AUTHENTICATING');
  });

  // Handle ready
  client.on('ready', async () => {
    console.log(`Client ready for ${accountId}`);
    const info = client.info;
    const phoneNumber = info?.wid?.user || null;

    clientInfo.status = 'CONNECTED';
    clientInfo.phoneNumber = phoneNumber;
    clientInfo.qrCode = undefined;

    await updateAccountStatus(accountId, 'CONNECTED', {
      phoneNumber,
      qrCode: null,
    });
  });

  // Handle auth failure
  client.on('auth_failure', async (msg) => {
    console.error(`Auth failed for ${accountId}:`, msg);
    clientInfo.status = 'FAILED';
    await updateAccountStatus(accountId, 'FAILED');
  });

  // Handle disconnect
  client.on('disconnected', async (reason) => {
    console.log(`Client disconnected for ${accountId}:`, reason);
    await updateAccountStatus(accountId, 'DISCONNECTED');
    clients.delete(accountId);
  });

  // Initialize in background (non-blocking for multiple connections)
  client.initialize().catch(async (error) => {
    console.error(`Failed to initialize client for ${accountId}:`, error.message);

    // Retry logic for lock file errors
    if (error.message.includes('profile appears to be in use') && retryCount < MAX_RETRIES) {
      console.log(`🔄 Retrying initialization for ${accountId} in 3 seconds...`);
      clients.delete(accountId);

      setTimeout(async () => {
        try {
          await initializeClient(accountId, retryCount + 1);
        } catch (retryError) {
          console.error(`Retry failed for ${accountId}:`, retryError.message);
          await updateAccountStatus(accountId, 'FAILED');
        }
      }, 3000);
    } else {
      await updateAccountStatus(accountId, 'FAILED');
      clients.delete(accountId);
    }
  });
}

// Routes

// Get all accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await prisma.whatsAppAccount.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const accountsWithClientStatus = accounts.map((account) => {
      const clientStatus = clients.get(account.id);
      return {
        ...account,
        clientStatus: clientStatus?.status || account.status,
        hasActiveClient: !!clientStatus,
      };
    });

    res.json(accountsWithClientStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create account
app.post('/api/accounts', async (req, res) => {
  try {
    const { name } = req.body;
    const account = await prisma.whatsAppAccount.create({
      data: { name },
    });
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get account by ID
app.get('/api/accounts/:id', async (req, res) => {
  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const clientStatus = clients.get(req.params.id);
    res.json({
      ...account,
      clientStatus: clientStatus?.status || account.status,
      hasActiveClient: !!clientStatus,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Connect account
app.post('/api/accounts/:id/connect', async (req, res) => {
  try {
    await initializeClient(req.params.id);
    res.json({ success: true, message: 'Client initialization started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect account
app.post('/api/accounts/:id/disconnect', async (req, res) => {
  try {
    const clientInfo = clients.get(req.params.id);
    if (!clientInfo) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await clientInfo.client.destroy();
    clients.delete(req.params.id);
    await updateAccountStatus(req.params.id, 'DISCONNECTED');

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete account
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const clientInfo = clients.get(req.params.id);
    if (clientInfo) {
      try {
        await clientInfo.client.destroy();
      } catch (e) {}
      clients.delete(req.params.id);
    }

    await prisma.whatsAppAccount.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { accountId, to, message } = req.body;

    const clientInfo = clients.get(accountId);
    if (!clientInfo) {
      return res.status(400).json({ error: 'Client not initialized' });
    }

    if (clientInfo.status !== 'CONNECTED') {
      return res.status(400).json({ error: `Client not connected: ${clientInfo.status}` });
    }

    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    const sentMessage = await clientInfo.client.sendMessage(chatId, message);

    await prisma.message.create({
      data: {
        accountId,
        to,
        message,
        status: 'SENT',
      },
    });

    res.json({ success: true, messageId: sentMessage.id.id });
  } catch (error) {
    await prisma.message.create({
      data: {
        accountId: req.body.accountId,
        to: req.body.to,
        message: req.body.message,
        status: 'FAILED',
      },
    }).catch(() => {});

    res.status(500).json({ error: error.message });
  }
});

// Get messages
app.get('/api/accounts/:id/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await prisma.message.findMany({
      where: { accountId: req.params.id },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: isShuttingDown ? 'shutting_down' : 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeClients: clients.size,
    clients: Array.from(clients.entries()).map(([id, info]) => ({
      accountId: id,
      status: info.status,
      hasPhone: !!info.phoneNumber,
    })),
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };

  res.json(health);
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log(`\n⚠️  Received ${signal}, starting graceful shutdown...\n`);
  isShuttingDown = true;

  // Close all WhatsApp clients
  const shutdownPromises = [];

  for (const [accountId, clientInfo] of clients.entries()) {
    console.log(`Closing client for ${accountId}...`);

    const promise = (async () => {
      try {
        await clientInfo.client.destroy();
        console.log(`✅ Client ${accountId} closed`);
      } catch (error) {
        console.error(`Failed to close client ${accountId}:`, error.message);
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
  console.log('✅ Database disconnected');

  // Exit
  console.log('👋 Shutdown complete\n');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Monitor resources every minute
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`
📊 Resource Monitor:
  - Active Clients: ${clients.size}
  - Memory Used: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB
  - RSS: ${Math.round(used.rss / 1024 / 1024)}MB
  - Uptime: ${Math.round(process.uptime() / 60)} minutes
  `);
}, 60000);

const PORT = process.env.API_PORT || 5001;
const server = app.listen(PORT, async () => {
  console.log(`\n🚀 WhatsApp API Server running on http://localhost:${PORT}\n`);

  // Clean lock files on startup
  cleanLockFiles();

  // Reset ALL accounts to DISCONNECTED on server restart
  // This prevents "Client not initialized" errors after container restarts
  try {
    const updated = await prisma.whatsAppAccount.updateMany({
      where: {
        status: {
          not: 'DISCONNECTED',
        },
      },
      data: {
        status: 'DISCONNECTED',
        qrCode: null,
      },
    });

    if (updated.count > 0) {
      console.log(`🔄 Reset ${updated.count} account(s) to DISCONNECTED (server restart)\n`);
    }
  } catch (error) {
    if (error.code === 'P2021') {
      console.warn('⚠️  Database tables not found. Run migrations first:');
      console.warn('   docker-compose exec wa-manager npx prisma migrate deploy\n');
    } else {
      console.error('Failed to reset accounts:', error.message);
    }
  }

  console.log(`💡 Ready to accept connections\n`);
  console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
});
