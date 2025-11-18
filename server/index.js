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

  // Rate limiting
  RATE_LIMIT_WINDOW: 60000, // 1 minute window
  RATE_LIMIT_MAX_MESSAGES: 100, // Max 30 messages per minute per account

  // Memory management
  MEMORY_CHECK_INTERVAL: 60000, // Check every minute
  MEMORY_WARNING_THRESHOLD: 0.75, // Warn at 75%
  MEMORY_CRITICAL_THRESHOLD: 0.85, // Critical at 85%

  // Message queue
  MESSAGE_RETRY_COUNT: 3,
  MESSAGE_RETRY_DELAY: 5000, // 5 seconds between retries

  // Resource monitoring
  RESOURCE_MONITOR_INTERVAL: 300000, // 5 minutes
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

// Message queue for retry logic
const messageQueues = new Map();

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

// Check rate limit for account
function checkRateLimit(accountId) {
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

// Process message queue for an account
async function processMessageQueue(accountId) {
  const queue = messageQueues.get(accountId);
  if (!queue || queue.length === 0) return;

  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") return;

  const msg = queue[0];

  try {
    // Format JID
    let jid = msg.to;
    if (!msg.to.includes("@")) {
      jid = `${msg.to}@s.whatsapp.net`;
    }

    // Send message
    const sentMessage = await clientInfo.sock.sendMessage(jid, {
      text: msg.message,
    });

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

    // Remove from queue
    queue.shift();

    logger.info(`Message sent from ${accountId} to ${msg.to}`);

    // Process next message
    if (queue.length > 0) {
      setTimeout(() => processMessageQueue(accountId), 1000);
    }

    return sentMessage;
  } catch (error) {
    logger.error(`Failed to send message from ${accountId}:`, error.message);

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
        `Message permanently failed after ${CONFIG.MESSAGE_RETRY_COUNT} retries`
      );
    } else {
      // Retry later
      setTimeout(
        () => processMessageQueue(accountId),
        CONFIG.MESSAGE_RETRY_DELAY
      );
      logger.info(
        `Retrying message (attempt ${msg.retries + 1}/${
          CONFIG.MESSAGE_RETRY_COUNT
        })`
      );
    }

    throw error;
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
      lastHeartbeat: clientStatus?.lastHeartbeat || null,
      latency: clientStatus?.latency || null,
    });
  } catch (error) {
    logger.error("Failed to get account:", error);
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

// Send message with rate limiting and queue
app.post("/api/messages/send", async (req, res) => {
  try {
    const { accountId, to, message } = req.body;

    if (!accountId || !to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check rate limit
    const rateCheck = checkRateLimit(accountId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded. Try again in ${rateCheck.resetIn} seconds`,
        resetIn: rateCheck.resetIn,
      });
    }

    const clientInfo = clients.get(accountId);
    if (!clientInfo) {
      return res.status(400).json({ error: "Client not initialized" });
    }

    if (clientInfo.status !== "CONNECTED") {
      // Queue message for later
      const messageId = enqueueMessage(accountId, to, message);
      return res.status(202).json({
        success: true,
        queued: true,
        messageId,
        message: "Message queued for delivery when connected",
      });
    }

    // Update last activity
    clientInfo.lastActivity = Date.now();

    // Format phone number (add @s.whatsapp.net if not present)
    let jid = to;
    if (!to.includes("@")) {
      jid = `${to}@s.whatsapp.net`;
    }

    // Send message
    const sentMessage = await clientInfo.sock.sendMessage(jid, {
      text: message,
    });

    // Save to database
    await prisma.message.create({
      data: {
        accountId,
        chatId: jid,
        direction: "OUTGOING",
        message,
        to,
        status: "SENT",
        contactNumber: to,
      },
    });

    logger.info(`Message sent from ${accountId} to ${to}`);

    res.json({
      success: true,
      messageId: sentMessage.key.id,
      timestamp: sentMessage.messageTimestamp,
    });
  } catch (error) {
    logger.error("Failed to send message:", error);

    // Save failed message
    try {
      await prisma.message.create({
        data: {
          accountId: req.body.accountId,
          message: req.body.message,
          to: req.body.to,
          direction: "OUTGOING",
          status: "FAILED",
          contactNumber: req.body.to,
        },
      });
    } catch (dbError) {
      logger.error("Failed to save failed message:", dbError);
    }

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
