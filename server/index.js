const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// Store active WhatsApp clients
const clients = new Map();

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

// Initialize WhatsApp client for an account
async function initializeClient(accountId) {
  console.log(`Initializing client for ${accountId}`);

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
    console.error(`Failed to initialize client for ${accountId}:`, error);
    await updateAccountStatus(accountId, 'FAILED');
    clients.delete(accountId);
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

// Restore clients on server start
async function restoreClients() {
  try {
    const connectedAccounts = await prisma.whatsAppAccount.findMany({
      where: {
        status: {
          in: ['CONNECTED', 'QR_READY', 'CONNECTING', 'AUTHENTICATING'],
        },
      },
    });

    if (connectedAccounts.length > 0) {
      console.log(`\n🔄 Restoring ${connectedAccounts.length} client(s)...\n`);

      for (const account of connectedAccounts) {
        try {
          await initializeClient(account.id);
        } catch (error) {
          console.error(`Failed to restore client for ${account.id}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Failed to restore clients:', error);
  }
}

const PORT = process.env.API_PORT || 5001;
app.listen(PORT, async () => {
  console.log(`\n🚀 WhatsApp API Server running on http://localhost:${PORT}\n`);

  // Restore previously connected clients
  await restoreClients();
});
