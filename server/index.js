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

// Store active WhatsApp sockets
const clients = new Map();

// Graceful shutdown flag
let isShuttingDown = false;

// Auth sessions directory
const SESSIONS_DIR = path.join(process.cwd(), ".baileys_auth");
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

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

// Initialize WhatsApp client with Baileys
async function initializeClient(accountId) {
  if (isShuttingDown) {
    throw new Error("Server is shutting down");
  }

  logger.info(`Initializing Baileys client for ${accountId}`);

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error("Account not found");
  }

  // Check if client already exists
  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === "CONNECTED" || existing.status === "CONNECTING") {
      throw new Error("Client already initialized");
    }
  }

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

    // Create socket
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
    });

    const clientInfo = {
      accountId,
      sock,
      status: "CONNECTING",
      qrCode: null,
      phoneNumber: null,
    };

    clients.set(accountId, clientInfo);

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
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        logger.info(
          `Connection closed for ${accountId}. Reconnect: ${shouldReconnect}`
        );

        if (shouldReconnect && !isShuttingDown) {
          // Auto-reconnect after 5 seconds
          setTimeout(() => {
            initializeClient(accountId).catch(err => {
              logger.error(`Failed to reconnect ${accountId}:`, err);
            });
          }, 5000);
        } else {
          await updateAccountStatus(accountId, "DISCONNECTED");
          clients.delete(accountId);

          // Clean up auth if logged out
          if (
            lastDisconnect?.error?.output?.statusCode ===
            DisconnectReason.loggedOut
          ) {
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
        logger.info(`Connection opened for ${accountId}`);
        clientInfo.status = "CONNECTED";
        clientInfo.qrCode = null;

        // Get phone number
        const phoneNumber = sock.user?.id?.split(":")[0] || null;
        clientInfo.phoneNumber = phoneNumber;

        await updateAccountStatus(accountId, "CONNECTED", {
          phoneNumber,
          qrCode: null,
        });
      } else if (connection === "connecting") {
        logger.info(`Connecting ${accountId}...`);
        clientInfo.status = "AUTHENTICATING";
        await updateAccountStatus(accountId, "AUTHENTICATING");
      }
    });

    // Save credentials on update
    sock.ev.on("creds.update", saveCreds);

    // Handle messages (optional - for logging)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type === "notify") {
        for (const msg of messages) {
          if (!msg.key.fromMe && msg.message) {
            logger.debug(`New message from ${msg.key.remoteJid}`);
          }
        }
      }
    });
  } catch (error) {
    logger.error(`Failed to initialize client for ${accountId}:`, error);
    await updateAccountStatus(accountId, "FAILED");
    clients.delete(accountId);
    throw error;
  }
}

// Routes

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
    const { name } = req.body;
    const account = await prisma.whatsAppAccount.create({
      data: { name },
    });
    logger.info(`Created account: ${account.id} (${name})`);
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
    });
  } catch (error) {
    logger.error("Failed to get account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Connect account
app.post("/api/accounts/:id/connect", async (req, res) => {
  try {
    await initializeClient(req.params.id);
    res.json({ success: true, message: "Client initialization started" });
  } catch (error) {
    logger.error("Failed to connect:", error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect account
app.post("/api/accounts/:id/disconnect", async (req, res) => {
  try {
    const clientInfo = clients.get(req.params.id);
    if (!clientInfo) {
      return res.status(404).json({ error: "Client not found" });
    }

    // Close the socket
    await clientInfo.sock.logout();
    clients.delete(req.params.id);
    await updateAccountStatus(req.params.id, "DISCONNECTED");

    logger.info(`Disconnected client: ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to disconnect:", error);
    res.status(500).json({ error: error.message });
  }
});

// Delete account
app.delete("/api/accounts/:id", async (req, res) => {
  try {
    const clientInfo = clients.get(req.params.id);
    if (clientInfo) {
      try {
        await clientInfo.sock.logout();
      } catch (e) {
        logger.error("Error during logout:", e);
      }
      clients.delete(req.params.id);
    }

    // Delete session files
    const sessionPath = getSessionPath(req.params.id);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    await prisma.whatsAppAccount.delete({
      where: { id: req.params.id },
    });

    logger.info(`Deleted account: ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Send message
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

    if (clientInfo.status !== "CONNECTED") {
      return res
        .status(400)
        .json({ error: `Client not connected: ${clientInfo.status}` });
    }

    // Format phone number (add @s.whatsapp.net if not present)
    let jid = to;
    if (!to.includes("@")) {
      jid = `${to}@s.whatsapp.net`;
    }

    // Send message
    const sentMessage = await clientInfo.sock.sendMessage(jid, {
      text: message,
    });

    logger.info(`Message sent from ${accountId} to ${to}`);

    res.json({
      success: true,
      messageId: sentMessage.key.id,
      timestamp: sentMessage.messageTimestamp,
    });
  } catch (error) {
    logger.error("Failed to send message:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  const health = {
    status: isShuttingDown ? "shutting_down" : "ok",
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

    for (const account of connectedAccounts) {
      try {
        logger.info(`Restoring: ${account.name} (${account.id})`);
        await initializeClient(account.id);
      } catch (error) {
        logger.error(`Failed to restore ${account.name}:`, error.message);
      }
    }

    logger.info(
      `Auto-restore initiated for ${connectedAccounts.length} account(s)`
    );
  } catch (error) {
    logger.error("Failed to restore connected clients:", error.message);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  // Close all WhatsApp clients
  const shutdownPromises = [];

  for (const [accountId, clientInfo] of clients.entries()) {
    logger.info(`Closing client for ${accountId}...`);

    const promise = (async () => {
      try {
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

// Monitor resources every 5 minutes
setInterval(() => {
  const used = process.memoryUsage();
  logger.info(
    {
      activeClients: clients.size,
      memoryUsedMB: Math.round(used.heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(used.heapTotal / 1024 / 1024),
      rssMB: Math.round(used.rss / 1024 / 1024),
      uptimeMinutes: Math.round(process.uptime() / 60),
    },
    "Resource Monitor"
  );
}, 300000); // 5 minutes

const PORT = process.env.API_PORT || 5001;
const server = app.listen(PORT, async () => {
  logger.info(`WhatsApp API Server running on http://localhost:${PORT}`);
  logger.info(`Using Baileys - Pure WhatsApp Web API`);

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

  // Auto-restore connected clients
  await restoreConnectedClients();

  logger.info("Ready to accept connections");
  logger.info(`Health check: http://localhost:${PORT}/health`);
});
