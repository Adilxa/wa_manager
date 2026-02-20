const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const { contractQueue, messageQueue } = require("./queue");
const { initializeWorkers } = require("./workers");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

// Prisma with connection pooling for high load
const prisma = new PrismaClient({
  log: ["error"],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

const app = express();

// CORS configuration
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

// Logger configuration - minimal for production
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
  RECONNECT_BASE_DELAY: 2000,
  RECONNECT_MAX_DELAY: 300000,

  // Heartbeat - less frequent to reduce load
  HEARTBEAT_INTERVAL: 60000, // Check every 60 seconds
  HEARTBEAT_TIMEOUT: 15000,

  // Initialization timeout
  INIT_TIMEOUT: 120000,

  // Rate limiting
  RATE_LIMIT_WINDOW: 60000,
  RATE_LIMIT_MAX_MESSAGES: 20,

  // Daily limits
  DAILY_MESSAGE_LIMIT_NEW_ACCOUNT: 500,
  DAILY_MESSAGE_LIMIT_OLD_ACCOUNT: 1000,
  DAILY_NEW_CHATS_LIMIT: 100,

  // Memory management - CRITICAL FOR 100+ USERS
  MEMORY_CHECK_INTERVAL: 30000, // Check every 30 seconds
  MEMORY_WARNING_THRESHOLD: 0.70, // Warn at 70%
  MEMORY_CRITICAL_THRESHOLD: 0.80, // Critical at 80%
  MEMORY_EMERGENCY_THRESHOLD: 0.90, // Emergency at 90%

  // Cleanup intervals
  CLEANUP_INTERVAL: 300000, // Cleanup every 5 minutes
  MAP_ENTRY_TTL: 86400000, // 24 hours TTL for map entries
  SESSION_CLEANUP_INTERVAL: 3600000, // Cleanup sessions every hour

  // Message queue
  MESSAGE_RETRY_COUNT: 3,
  MESSAGE_RETRY_DELAY: 5000,

  // Resource monitoring
  RESOURCE_MONITOR_INTERVAL: 60000, // Every minute

  // Human-like behavior delays
  TYPING_SPEED_MIN: 30,
  TYPING_SPEED_MAX: 100,
  DELAY_BEFORE_TYPING_MIN: 500,
  DELAY_BEFORE_TYPING_MAX: 2000,
  DELAY_BETWEEN_MESSAGES_MIN: 3000,
  DELAY_BETWEEN_MESSAGES_MAX: 8000,
  REST_AFTER_MESSAGES: 5,
  REST_DURATION_MIN: 30000,
  REST_DURATION_MAX: 120000,

  // Per-client limits
  MAX_CLIENTS: 150, // Maximum concurrent clients
  MAX_QUEUE_SIZE_PER_CLIENT: 1000, // Maximum queue size per client
};

// ==================== STATE MANAGEMENT ====================

// Store active WhatsApp sockets - WeakRef where possible
const clients = new Map();

// Track reconnection attempts
const reconnectAttempts = new Map();

// Track accounts being connected
const connectingAccounts = new Set();

// Rate limiting tracker with timestamps for cleanup
const rateLimiter = new Map();

// Daily limits tracker with timestamps
const dailyLimits = new Map();

// Message counters with timestamps
const messageCounters = new Map();

// Message queues with size limits
const messageQueues = new Map();

// Graceful shutdown flag
let isShuttingDown = false;

// Interval references
let heartbeatInterval = null;
let memoryMonitorInterval = null;
let watchdogInterval = null;
let cleanupInterval = null;

// Auth sessions directory
const SESSIONS_DIR = path.join(process.cwd(), ".baileys_auth");
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ==================== MEMORY-EFFICIENT LRU CACHE ====================

class LRUCache {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// Global caches with limits
const signalKeyCache = new LRUCache(5000);

// ==================== HELPER FUNCTIONS ====================

function getSessionPath(accountId) {
  return path.join(SESSIONS_DIR, `session_${accountId}`);
}

async function updateAccountStatus(accountId, status, data = {}) {
  try {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { status, ...data },
    });
    logger.info(`Status updated: ${accountId} -> ${status}`);
  } catch (error) {
    logger.error(`Failed to update status for ${accountId}:`, error.message);
  }
}

function getBackoffDelay(attempt) {
  const delay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, attempt),
    CONFIG.RECONNECT_MAX_DELAY
  );
  return delay + Math.random() * 1000;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateTypingDelay(message) {
  const length = message.length;
  const speed = randomDelay(CONFIG.TYPING_SPEED_MIN, CONFIG.TYPING_SPEED_MAX);
  return Math.min(length * speed, 5000); // Cap at 5 seconds
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== MEMORY CLEANUP FUNCTIONS ====================

// Clean up old entries from Maps
function cleanupMaps() {
  const now = Date.now();
  let cleaned = 0;

  // Clean rateLimiter - remove entries older than window
  for (const [accountId, data] of rateLimiter.entries()) {
    if (now - data.windowStart > CONFIG.RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(accountId);
      cleaned++;
    }
  }

  // Clean dailyLimits - reset old days
  const today = new Date().toDateString();
  for (const [accountId, data] of dailyLimits.entries()) {
    if (data.date !== today) {
      dailyLimits.delete(accountId);
      cleaned++;
    }
  }

  // Clean messageCounters - remove for disconnected clients
  for (const [accountId, data] of messageCounters.entries()) {
    const client = clients.get(accountId);
    if (!client || client.status !== "CONNECTED") {
      if (now - (data.lastActivity || 0) > CONFIG.MAP_ENTRY_TTL) {
        messageCounters.delete(accountId);
        cleaned++;
      }
    }
  }

  // Clean empty message queues
  for (const [accountId, queue] of messageQueues.entries()) {
    if (queue.length === 0) {
      const client = clients.get(accountId);
      if (!client || client.status !== "CONNECTED") {
        messageQueues.delete(accountId);
        cleaned++;
      }
    }
  }

  // Clean old reconnect attempts
  for (const [accountId, attempts] of reconnectAttempts.entries()) {
    const client = clients.get(accountId);
    if (client && client.status === "CONNECTED") {
      reconnectAttempts.delete(accountId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale map entries`);
  }

  return cleaned;
}

// Clean up old session files for deleted accounts
async function cleanupStaleSessions() {
  try {
    const sessionDirs = fs.readdirSync(SESSIONS_DIR);
    const accountIds = await prisma.whatsAppAccount.findMany({
      select: { id: true },
    });
    const validIds = new Set(accountIds.map(a => `session_${a.id}`));

    let cleaned = 0;
    for (const dir of sessionDirs) {
      if (!validIds.has(dir)) {
        const sessionPath = path.join(SESSIONS_DIR, dir);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          cleaned++;
          logger.info(`Removed stale session: ${dir}`);
        } catch (err) {
          logger.error(`Failed to remove stale session ${dir}:`, err.message);
        }
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} stale session directories`);
    }
  } catch (error) {
    logger.error("Failed to cleanup stale sessions:", error.message);
  }
}

// Force garbage collection
function forceGC() {
  if (global.gc) {
    const before = process.memoryUsage().heapUsed;
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const freedMB = Math.round((before - after) / 1024 / 1024);
    if (freedMB > 0) {
      logger.info(`GC freed ${freedMB}MB`);
    }
    return freedMB;
  }
  return 0;
}

// Start periodic cleanup
function startCleanupRoutine() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  cleanupInterval = setInterval(() => {
    cleanupMaps();
    forceGC();
  }, CONFIG.CLEANUP_INTERVAL);

  // Session cleanup less frequently
  setInterval(cleanupStaleSessions, CONFIG.SESSION_CLEANUP_INTERVAL);

  logger.info("Cleanup routine started");
}

// ==================== RATE LIMITING ====================

async function checkRateLimit(accountId) {
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { useLimits: true },
  });

  if (!account || !account.useLimits) {
    return { allowed: true, noLimits: true };
  }

  const now = Date.now();

  if (!rateLimiter.has(accountId)) {
    rateLimiter.set(accountId, { count: 0, windowStart: now });
  }

  const limiter = rateLimiter.get(accountId);

  if (now - limiter.windowStart > CONFIG.RATE_LIMIT_WINDOW) {
    limiter.count = 0;
    limiter.windowStart = now;
  }

  if (limiter.count >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    const resetIn = Math.ceil(
      (limiter.windowStart + CONFIG.RATE_LIMIT_WINDOW - now) / 1000
    );
    return { allowed: false, resetIn };
  }

  limiter.count++;
  return { allowed: true };
}

async function checkDailyLimit(accountId) {
  const today = new Date().toDateString();

  if (!dailyLimits.has(accountId)) {
    dailyLimits.set(accountId, {
      date: today,
      messageCount: 0,
      newChatsCount: 0,
    });
  }

  const limits = dailyLimits.get(accountId);

  if (limits.date !== today) {
    limits.date = today;
    limits.messageCount = 0;
    limits.newChatsCount = 0;
  }

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { useLimits: true, createdAt: true },
  });

  if (!account) {
    return { allowed: false, reason: "Account not found" };
  }

  if (!account.useLimits) {
    return { allowed: true, isNewAccount: false, noLimits: true };
  }

  const accountAge = Date.now() - new Date(account.createdAt).getTime();
  const isNewAccount = accountAge < 7 * 24 * 60 * 60 * 1000;

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

async function checkNeedRest(accountId) {
  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { useLimits: true },
  });

  if (!account || !account.useLimits) {
    return { needRest: false, noLimits: true };
  }

  if (!messageCounters.has(accountId)) {
    messageCounters.set(accountId, {
      count: 0,
      lastRest: Date.now(),
      isResting: false,
      lastActivity: Date.now(),
    });
  }

  const counter = messageCounters.get(accountId);
  counter.lastActivity = Date.now();

  if (counter.isResting) {
    return { needRest: true, reason: "Currently resting" };
  }

  if (counter.count >= CONFIG.REST_AFTER_MESSAGES) {
    return { needRest: true, reason: "Need rest after messages" };
  }

  return { needRest: false };
}

// ==================== CLIENT CLEANUP ====================

async function cleanupClient(accountId) {
  const clientInfo = clients.get(accountId);
  if (clientInfo) {
    try {
      // Remove all event listeners first
      if (clientInfo.sock && clientInfo.sock.ev) {
        clientInfo.sock.ev.removeAllListeners();
      }

      // Close the socket
      if (clientInfo.sock) {
        try {
          await clientInfo.sock.end();
        } catch (e) {
          // Ignore end errors
        }
        clientInfo.sock = null;
      }

      logger.info(`Cleaned up socket for ${accountId}`);
    } catch (error) {
      logger.error(`Error cleaning up client ${accountId}:`, error.message);
    }
  }
  clients.delete(accountId);
  connectingAccounts.delete(accountId);

  // Clear related data
  messageQueues.delete(accountId);
  rateLimiter.delete(accountId);
  messageCounters.delete(accountId);
}

// ==================== RECONNECTION LOGIC ====================

async function reconnectWithBackoff(accountId) {
  if (isShuttingDown) return;

  const attempts = reconnectAttempts.get(accountId) || 0;

  if (attempts >= CONFIG.RECONNECT_MAX_RETRIES) {
    logger.error(`Max reconnection attempts reached for ${accountId}`);
    await updateAccountStatus(accountId, "FAILED");
    reconnectAttempts.delete(accountId);
    return;
  }

  const delay = getBackoffDelay(attempts);

  logger.info(
    `Reconnecting ${accountId} in ${Math.round(delay / 1000)}s (attempt ${attempts + 1}/${CONFIG.RECONNECT_MAX_RETRIES})`
  );

  setTimeout(async () => {
    if (isShuttingDown) return;

    reconnectAttempts.set(accountId, attempts + 1);

    try {
      await initializeClient(accountId);
      reconnectAttempts.delete(accountId);
    } catch (error) {
      logger.error(`Reconnection failed for ${accountId}: ${error.message}`);
      await reconnectWithBackoff(accountId);
    }
  }, delay);
}

// ==================== HEARTBEAT SYSTEM ====================

function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  heartbeatInterval = setInterval(async () => {
    if (isShuttingDown) return;

    const clientCount = clients.size;
    let checkedCount = 0;

    for (const [accountId, clientInfo] of clients.entries()) {
      if (clientInfo.status === "CONNECTED") {
        try {
          const pingStart = Date.now();

          const pingPromise = clientInfo.sock.sendPresenceUpdate("available");
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Heartbeat timeout")), CONFIG.HEARTBEAT_TIMEOUT)
          );

          await Promise.race([pingPromise, timeoutPromise]);

          clientInfo.lastHeartbeat = Date.now();
          clientInfo.latency = Date.now() - pingStart;
          checkedCount++;
        } catch (error) {
          logger.warn(`Heartbeat failed for ${accountId}: ${error.message}`);
          clientInfo.status = "DISCONNECTED";
          await updateAccountStatus(accountId, "DISCONNECTED");
          await cleanupClient(accountId);
          await reconnectWithBackoff(accountId);
        }
      }
    }

    if (checkedCount > 0) {
      logger.debug(`Heartbeat checked ${checkedCount}/${clientCount} clients`);
    }
  }, CONFIG.HEARTBEAT_INTERVAL);

  logger.info(`Heartbeat started (interval: ${CONFIG.HEARTBEAT_INTERVAL / 1000}s)`);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ==================== MEMORY MANAGEMENT ====================

function startMemoryMonitor() {
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
  }

  memoryMonitorInterval = setInterval(async () => {
    const used = process.memoryUsage();
    const heapPercent = used.heapUsed / used.heapTotal;
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);

    // Emergency - disconnect clients to save memory
    if (heapPercent > CONFIG.MEMORY_EMERGENCY_THRESHOLD) {
      logger.error(`EMERGENCY: Memory at ${Math.round(heapPercent * 100)}% (${heapUsedMB}/${heapTotalMB}MB)`);

      // Force GC multiple times
      forceGC();
      forceGC();

      // Disconnect 30% of least active clients
      const clientsToDisconnect = Math.max(1, Math.ceil(clients.size * 0.3));

      if (clients.size > 1) {
        const sortedClients = Array.from(clients.entries())
          .filter(([_, info]) => info.status === "CONNECTED")
          .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0))
          .slice(0, clientsToDisconnect);

        for (const [accountId] of sortedClients) {
          try {
            logger.warn(`Emergency disconnect: ${accountId}`);
            await cleanupClient(accountId);
            await updateAccountStatus(accountId, "DISCONNECTED");
          } catch (error) {
            logger.error(`Failed to emergency disconnect ${accountId}:`, error.message);
          }
        }
      }

      // Clean all maps aggressively
      cleanupMaps();
      signalKeyCache.clear();
    }
    // Critical - cleanup and GC
    else if (heapPercent > CONFIG.MEMORY_CRITICAL_THRESHOLD) {
      logger.error(`CRITICAL: Memory at ${Math.round(heapPercent * 100)}% (${heapUsedMB}/${heapTotalMB}MB)`);
      cleanupMaps();
      forceGC();

      // Disconnect 10% of least active clients
      if (clients.size > 5) {
        const clientsToDisconnect = Math.ceil(clients.size * 0.1);
        const sortedClients = Array.from(clients.entries())
          .filter(([_, info]) => info.status === "CONNECTED")
          .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0))
          .slice(0, clientsToDisconnect);

        for (const [accountId] of sortedClients) {
          try {
            logger.warn(`Critical memory disconnect: ${accountId}`);
            await cleanupClient(accountId);
            await updateAccountStatus(accountId, "DISCONNECTED");
          } catch (error) {
            logger.error(`Failed to disconnect ${accountId}:`, error.message);
          }
        }
      }
    }
    // Warning - just cleanup and GC
    else if (heapPercent > CONFIG.MEMORY_WARNING_THRESHOLD) {
      logger.warn(`WARNING: Memory at ${Math.round(heapPercent * 100)}% (${heapUsedMB}/${heapTotalMB}MB)`);
      cleanupMaps();
      forceGC();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL);

  logger.info("Memory monitor started");
}

// ==================== WATCHDOG ====================

function startWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
  }

  watchdogInterval = setInterval(async () => {
    const now = Date.now();
    const STUCK_TIMEOUT = 300000;
    const CONNECTING_TIMEOUT = 120000;
    const HEARTBEAT_DEAD_TIMEOUT = 180000;

    // Check stuck connecting accounts
    for (const accountId of connectingAccounts) {
      const clientInfo = clients.get(accountId);
      const timeSinceActivity = clientInfo?.lastActivity
        ? now - clientInfo.lastActivity
        : CONNECTING_TIMEOUT + 1;

      if (timeSinceActivity > CONNECTING_TIMEOUT) {
        logger.warn(`Watchdog: ${accountId} stuck connecting, forcing cleanup`);
        await cleanupClient(accountId);
        await updateAccountStatus(accountId, "DISCONNECTED");
      }
    }

    // Check stuck clients
    for (const [accountId, clientInfo] of clients.entries()) {
      if (clientInfo.status === "AUTHENTICATING" || clientInfo.status === "CONNECTING") {
        const timeSinceActivity = clientInfo.lastActivity
          ? now - clientInfo.lastActivity
          : STUCK_TIMEOUT + 1;

        if (timeSinceActivity > STUCK_TIMEOUT) {
          logger.warn(`Watchdog: ${accountId} stuck in ${clientInfo.status}, reconnecting`);
          await cleanupClient(accountId);
          setTimeout(() => initializeClient(accountId).catch(() => {}), 5000);
        }
      }

      // Check dead connections
      if (clientInfo.status === "CONNECTED" && clientInfo.lastHeartbeat) {
        const timeSinceHeartbeat = now - clientInfo.lastHeartbeat;
        if (timeSinceHeartbeat > HEARTBEAT_DEAD_TIMEOUT) {
          logger.warn(`Watchdog: ${accountId} no heartbeat, reconnecting`);
          await cleanupClient(accountId);
          await reconnectWithBackoff(accountId);
        }
      }
    }
  }, 60000);

  logger.info("Watchdog started");
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

// ==================== MESSAGE QUEUE SYSTEM ====================

function enqueueMessage(accountId, to, message) {
  if (!messageQueues.has(accountId)) {
    messageQueues.set(accountId, []);
  }

  const queue = messageQueues.get(accountId);

  // Enforce queue size limit
  if (queue.length >= CONFIG.MAX_QUEUE_SIZE_PER_CLIENT) {
    logger.warn(`Queue full for ${accountId}, dropping oldest message`);
    queue.shift();
  }

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

async function sendMessageWithHumanBehavior(accountId, jid, message) {
  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    throw new Error("Client not connected");
  }

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { useLimits: true },
  });

  // No limits - send immediately
  if (account && !account.useLimits) {
    const sentMessage = await clientInfo.sock.sendMessage(jid, { text: message });
    clientInfo.lastActivity = Date.now();
    return sentMessage;
  }

  // With limits - human-like behavior
  const delayBeforeTyping = randomDelay(CONFIG.DELAY_BEFORE_TYPING_MIN, CONFIG.DELAY_BEFORE_TYPING_MAX);
  await sleep(delayBeforeTyping);

  try {
    await clientInfo.sock.sendPresenceUpdate("composing", jid);
  } catch (err) {
    // Ignore presence errors
  }

  const typingDuration = calculateTypingDelay(message);
  await sleep(typingDuration);

  try {
    await clientInfo.sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    // Ignore presence errors
  }

  await sleep(randomDelay(200, 800));

  const sentMessage = await clientInfo.sock.sendMessage(jid, { text: message });
  clientInfo.lastActivity = Date.now();

  return sentMessage;
}

async function processMessageQueue(accountId) {
  const queue = messageQueues.get(accountId);
  if (!queue || queue.length === 0) return;

  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    setTimeout(() => processMessageQueue(accountId), 10000);
    return;
  }

  const restCheck = await checkNeedRest(accountId);
  if (restCheck.needRest && !restCheck.noLimits) {
    const counter = messageCounters.get(accountId);
    if (counter && !counter.isResting) {
      counter.isResting = true;
      const restDuration = randomDelay(CONFIG.REST_DURATION_MIN, CONFIG.REST_DURATION_MAX);
      logger.info(`Account ${accountId} resting for ${Math.round(restDuration / 1000)}s`);

      setTimeout(() => {
        counter.isResting = false;
        counter.count = 0;
        processMessageQueue(accountId);
      }, restDuration);
    }
    return;
  }

  const rateCheck = await checkRateLimit(accountId);
  if (!rateCheck.allowed && !rateCheck.noLimits) {
    setTimeout(() => processMessageQueue(accountId), rateCheck.resetIn * 1000);
    return;
  }

  const dailyCheck = await checkDailyLimit(accountId);
  if (!dailyCheck.allowed && !dailyCheck.noLimits) {
    setTimeout(() => processMessageQueue(accountId), 3600000);
    return;
  }

  const msg = queue[0];

  try {
    let jid = msg.to;
    if (!msg.to.includes("@")) {
      jid = `${msg.to}@s.whatsapp.net`;
    }

    await sendMessageWithHumanBehavior(accountId, jid, msg.message);

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

    // Update counters
    const limits = dailyLimits.get(accountId);
    if (limits) limits.messageCount++;

    const counter = messageCounters.get(accountId);
    if (counter) counter.count++;

    queue.shift();

    // Process next
    if (queue.length > 0) {
      const account = await prisma.whatsAppAccount.findUnique({
        where: { id: accountId },
        select: { useLimits: true },
      });

      if (account && !account.useLimits) {
        setTimeout(() => processMessageQueue(accountId), 100);
      } else {
        const nextDelay = randomDelay(CONFIG.DELAY_BETWEEN_MESSAGES_MIN, CONFIG.DELAY_BETWEEN_MESSAGES_MAX);
        setTimeout(() => processMessageQueue(accountId), nextDelay);
      }
    }
  } catch (error) {
    logger.error(`Failed to send message from ${accountId}:`, error.message);

    msg.retries++;

    if (msg.retries >= CONFIG.MESSAGE_RETRY_COUNT) {
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

      if (queue.length > 0) {
        setTimeout(() => processMessageQueue(accountId), 2000);
      }
    } else {
      setTimeout(() => processMessageQueue(accountId), CONFIG.MESSAGE_RETRY_DELAY);
    }
  }
}

// ==================== WHATSAPP CLIENT INITIALIZATION ====================

async function initializeClient(accountId) {
  if (isShuttingDown) {
    throw new Error("Server is shutting down");
  }

  // Check max clients limit
  if (clients.size >= CONFIG.MAX_CLIENTS) {
    throw new Error(`Maximum clients limit reached (${CONFIG.MAX_CLIENTS})`);
  }

  if (connectingAccounts.has(accountId)) {
    throw new Error("Client is already being initialized");
  }

  logger.info(`Initializing client for ${accountId}`);

  let account;
  try {
    account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new Error("Account not found");
    }
  } catch (dbError) {
    logger.error(`Database error for ${accountId}:`, dbError.message);
    throw dbError;
  }

  if (clients.has(accountId)) {
    const existing = clients.get(accountId);
    if (existing.status === "CONNECTED") {
      throw new Error("Client already connected");
    }
    await cleanupClient(accountId);
  }

  connectingAccounts.add(accountId);

  const sessionPath = getSessionPath(accountId);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  try {
    await updateAccountStatus(accountId, "CONNECTING");

    const { version } = await fetchLatestBaileysVersion();

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Create socket with MINIMAL memory footprint
    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      browser: ["WhatsApp Manager", "Chrome", "120.0.0"],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
      qrTimeout: 45000,
      emitOwnEvents: false,
      fireInitQueries: false,
      getMessage: async () => ({ conversation: "" }),
      // Disable message history caching
      shouldIgnoreJid: () => false,
      // Minimal retries
      maxMsgRetryCount: 2,
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

    const initTimeout = setTimeout(async () => {
      if (clientInfo.status !== "CONNECTED") {
        logger.error(`Init timeout for ${accountId}`);
        await cleanupClient(accountId);
        await updateAccountStatus(accountId, "FAILED");
      }
    }, CONFIG.INIT_TIMEOUT);

    // Connection update handler
    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          clientInfo.qrCode = qrDataUrl;
          clientInfo.status = "QR_READY";
          await updateAccountStatus(accountId, "QR_READY", { qrCode: qrDataUrl });
          logger.info(`QR ready for ${accountId}`);
        } catch (error) {
          logger.error(`QR generation failed for ${accountId}:`, error.message);
        }
      }

      if (connection === "close") {
        clearTimeout(initTimeout);
        connectingAccounts.delete(accountId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.info(`Connection closed for ${accountId}. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

        await cleanupClient(accountId);

        if (shouldReconnect && !isShuttingDown) {
          await reconnectWithBackoff(accountId);
        } else {
          await updateAccountStatus(accountId, "DISCONNECTED");
          reconnectAttempts.delete(accountId);

          if (statusCode === DisconnectReason.loggedOut) {
            try {
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
              }
            } catch (err) {
              logger.error(`Failed to clean auth for ${accountId}:`, err.message);
            }
          }
        }
      } else if (connection === "open") {
        clearTimeout(initTimeout);
        connectingAccounts.delete(accountId);

        logger.info(`Connected: ${accountId}`);
        clientInfo.status = "CONNECTED";
        clientInfo.qrCode = null;
        clientInfo.lastActivity = Date.now();
        clientInfo.lastHeartbeat = Date.now();

        reconnectAttempts.delete(accountId);

        const phoneNumber = sock.user?.id?.split(":")[0] || null;
        clientInfo.phoneNumber = phoneNumber;

        await updateAccountStatus(accountId, "CONNECTED", { phoneNumber, qrCode: null });

        processMessageQueue(accountId).catch(err => {
          logger.error(`Queue error for ${accountId}:`, err.message);
        });
      } else if (connection === "connecting") {
        clientInfo.status = "AUTHENTICATING";
        await updateAccountStatus(accountId, "AUTHENTICATING");
      }
    });

    // Save credentials
    sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages - minimal processing
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

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
        } catch (error) {
          logger.error(`Failed to save message for ${accountId}:`, error.message);
        }
      }
    });

    // Handle message updates - minimal
    sock.ev.on("messages.update", () => {
      clientInfo.lastActivity = Date.now();
    });

    // Handle presence updates - minimal
    sock.ev.on("presence.update", () => {
      clientInfo.lastActivity = Date.now();
    });

  } catch (error) {
    connectingAccounts.delete(accountId);
    logger.error(`Init failed for ${accountId}: ${error.message}`);
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
    logger.error("Failed to load accounts:", error.message);
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
    logger.info(`Created account: ${account.id} (${name})`);
    res.status(201).json(account);
  } catch (error) {
    logger.error("Failed to create account:", error.message);
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
    logger.error("Failed to get account:", error.message);
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

    res.json(account);
  } catch (error) {
    logger.error("Failed to update account:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Connect account
app.post("/api/accounts/:id/connect", async (req, res) => {
  try {
    const accountId = req.params.id;

    if (connectingAccounts.has(accountId)) {
      return res.status(400).json({ error: "Client is already being initialized" });
    }

    const existing = clients.get(accountId);
    if (existing && existing.status === "CONNECTED") {
      return res.status(400).json({ error: "Client already connected" });
    }

    if (existing && (existing.status === "AUTHENTICATING" || existing.status === "CONNECTING")) {
      const stuckTime = Date.now() - (existing.lastActivity || 0);
      if (stuckTime > 120000) {
        await cleanupClient(accountId);
      }
    }

    await initializeClient(accountId);
    res.json({ success: true, message: "Client initialization started" });
  } catch (error) {
    logger.error(`Failed to connect ${req.params.id}: ${error.message}`);
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

    reconnectAttempts.delete(accountId);
    connectingAccounts.delete(accountId);

    try {
      await clientInfo.sock.logout();
    } catch (e) {
      // Ignore logout errors
    }

    await cleanupClient(accountId);
    await updateAccountStatus(accountId, "DISCONNECTED");

    logger.info(`Disconnected: ${accountId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to disconnect:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Reset session
app.post("/api/accounts/:id/reset-session", async (req, res) => {
  try {
    const accountId = req.params.id;

    reconnectAttempts.delete(accountId);
    connectingAccounts.delete(accountId);

    const clientInfo = clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.sock.end();
      } catch (e) {}
      await cleanupClient(accountId);
    }

    const sessionPath = getSessionPath(accountId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    await updateAccountStatus(accountId, "DISCONNECTED");

    res.json({ success: true, message: "Session reset successfully" });
  } catch (error) {
    logger.error(`Failed to reset session ${req.params.id}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete account
app.delete("/api/accounts/:id", async (req, res) => {
  const accountId = req.params.id;

  try {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    reconnectAttempts.delete(accountId);

    const clientInfo = clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.sock.logout();
      } catch (e) {}
      await cleanupClient(accountId);
    }

    const sessionPath = getSessionPath(accountId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    await prisma.whatsAppAccount.delete({
      where: { id: accountId },
    });

    logger.info(`Deleted account: ${accountId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error(`Failed to delete account ${accountId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send message via BullMQ
app.post("/api/messages/send", async (req, res) => {
  try {
    const { accountId, to, message } = req.body;

    if (!accountId || !to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let clientInfo = clients.get(accountId);

    if (!clientInfo || clientInfo.status !== "CONNECTED") {
      try {
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId },
        });

        if (!account) {
          return res.status(404).json({ error: "Account not found" });
        }

        if (!clientInfo) {
          await initializeClient(accountId);
        } else if (clientInfo.status === "DISCONNECTED") {
          await cleanupClient(accountId);
          await initializeClient(accountId);
        }

        await sleep(2000);

        clientInfo = clients.get(accountId);
        if (!clientInfo || clientInfo.status !== "CONNECTED") {
          return res.status(503).json({
            error: "Account is connecting. Try again in a few seconds.",
            status: clientInfo?.status || "DISCONNECTED",
          });
        }
      } catch (connectError) {
        return res.status(503).json({
          error: "Failed to connect account",
          details: connectError.message,
        });
      }
    }

    const tempContract = await prisma.contract.create({
      data: {
        accountId,
        name: `Single message to ${to}`,
        totalCount: 1,
        pendingCount: 1,
        status: "PENDING",
        recipients: {
          create: {
            phoneNumber: to,
            message: message,
            status: "PENDING",
          },
        },
      },
      include: {
        recipients: true,
      },
    });

    const recipient = tempContract.recipients[0];

    const job = await messageQueue.add(
      `msg-${to}`,
      {
        contractId: tempContract.id,
        recipientId: recipient.id,
        accountId,
        phoneNumber: to,
        message: message,
      },
      {
        priority: 10,
      }
    );

    await prisma.contract.update({
      where: { id: tempContract.id },
      data: {
        status: "IN_PROGRESS",
        startedAt: new Date(),
      },
    });

    const queueCounts = await messageQueue.getJobCounts();

    res.status(202).json({
      success: true,
      queued: true,
      messageId: tempContract.id,
      contractId: tempContract.id,
      recipientId: recipient.id,
      jobId: job.id,
      queuePosition: queueCounts.waiting + 1,
      queueLength: queueCounts.waiting + queueCounts.active,
      message: "Message queued for delivery",
    });
  } catch (error) {
    logger.error("Failed to queue message:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get chats
app.get("/api/accounts/:id/chats", async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50, phone } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100); // Cap at 100
    const skip = (pageNum - 1) * limitNum;

    const where = { accountId: id };

    if (phone) {
      where.OR = [
        { to: { contains: phone } },
        { from: { contains: phone } },
        { contactNumber: { contains: phone } },
      ];
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { sentAt: "desc" },
      take: 5000, // Limit to prevent memory issues
    });

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
      if (chat.messages.length < 50) { // Limit messages per chat
        chat.messages.push(msg);
      }

      if (new Date(msg.sentAt) > new Date(chat.lastMessageTime)) {
        chat.lastMessageTime = msg.sentAt;
      }
    });

    let chatsArray = Array.from(chatsMap.values());
    chatsArray.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

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
    logger.error("Failed to get chats:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get chat messages
app.get("/api/accounts/:accountId/chats/:chatId", async (req, res) => {
  try {
    const { accountId, chatId } = req.params;
    const decodedChatId = decodeURIComponent(chatId);

    const messages = await prisma.message.findMany({
      where: { accountId, chatId: decodedChatId },
      orderBy: { sentAt: "asc" },
      take: 500, // Limit messages
    });

    res.json(messages);
  } catch (error) {
    logger.error("Failed to get chat messages:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send to chat
app.post("/api/accounts/:accountId/chats/:chatId", async (req, res) => {
  try {
    const { accountId, chatId } = req.params;
    const { message } = req.body;
    const decodedChatId = decodeURIComponent(chatId);

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    let clientInfo = clients.get(accountId);

    if (!clientInfo || clientInfo.status !== "CONNECTED") {
      try {
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId },
        });

        if (!account) {
          return res.status(404).json({ error: "Account not found" });
        }

        if (!clientInfo) {
          await initializeClient(accountId);
        } else if (clientInfo.status === "DISCONNECTED") {
          await cleanupClient(accountId);
          await initializeClient(accountId);
        }

        await sleep(2000);

        clientInfo = clients.get(accountId);
        if (!clientInfo || clientInfo.status !== "CONNECTED") {
          return res.status(503).json({
            error: "Account is connecting. Try again.",
            status: clientInfo?.status || "DISCONNECTED",
          });
        }
      } catch (connectError) {
        return res.status(503).json({
          error: "Failed to connect account",
          details: connectError.message,
        });
      }
    }

    const contactNumber = decodedChatId.split("@")[0];
    const queue = messageQueues.get(accountId) || [];
    const queueLength = queue.length;

    const messageId = enqueueMessage(accountId, contactNumber, message);

    if (queueLength === 0) {
      setTimeout(() => processMessageQueue(accountId), 100);
    }

    res.status(202).json({
      success: true,
      queued: true,
      messageId,
      queuePosition: queueLength + 1,
      queueLength: queueLength + 1,
      message: "Message queued for delivery",
    });
  } catch (error) {
    logger.error("Failed to queue chat message:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Queue status
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
      messages: queue.slice(0, 20).map((msg, index) => ({
        position: index + 1,
        to: msg.to,
        message: msg.message.substring(0, 50) + (msg.message.length > 50 ? "..." : ""),
        retries: msg.retries,
      })),
      status: {
        clientStatus: clientInfo?.status || "DISCONNECTED",
        isResting: counter?.isResting || false,
        messagesSinceRest: counter?.count || 0,
      },
      limits: {
        dailyCount: limitsInfo?.messageCount || 0,
        dailyLimit: dailyCheck.isNewAccount
          ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
          : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT,
      },
    });
  } catch (error) {
    logger.error("Failed to get queue status:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONTRACT API ROUTES ====================

app.post("/api/contracts", async (req, res) => {
  try {
    const { accountId, name, recipients } = req.body;

    if (!accountId || !name || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    for (const recipient of recipients) {
      if (!recipient.phoneNumber || !recipient.message) {
        return res.status(400).json({ error: "Each recipient must have phoneNumber and message" });
      }
    }

    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const contract = await prisma.contract.create({
      data: {
        accountId,
        name,
        totalCount: recipients.length,
        pendingCount: recipients.length,
        status: "PENDING",
        recipients: {
          create: recipients.map(r => ({
            phoneNumber: r.phoneNumber,
            message: r.message,
            status: "PENDING",
          })),
        },
      },
      include: {
        recipients: true,
      },
    });

    logger.info(`Created contract: ${contract.id} with ${recipients.length} recipients`);
    res.status(201).json(contract);
  } catch (error) {
    logger.error("Failed to create contract:", error.message);
    res.status(500).json({ error: error.message });
  }
});

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
          select: { id: true, name: true, phoneNumber: true },
        },
        _count: {
          select: { recipients: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json(contracts);
  } catch (error) {
    logger.error("Failed to get contracts:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/contracts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        account: {
          select: { id: true, name: true, phoneNumber: true },
        },
        recipients: {
          orderBy: { createdAt: "asc" },
          take: 1000,
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    res.json(contract);
  } catch (error) {
    logger.error("Failed to get contract:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/contracts/:id/start", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        recipients: {
          where: { status: { in: ["PENDING", "FAILED"] } },
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    if (contract.status === "COMPLETED") {
      return res.status(400).json({ error: "Contract already completed" });
    }

    if (contract.recipients.length === 0) {
      return res.status(400).json({ error: "No pending recipients" });
    }

    const clientInfo = clients.get(contract.accountId);
    if (!clientInfo || clientInfo.status !== "CONNECTED") {
      return res.status(400).json({ error: "Account not connected" });
    }

    const job = await contractQueue.add(
      `contract-${id}`,
      { contractId: id },
      {
        jobId: `contract-${id}`,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    res.json({
      success: true,
      message: "Contract queued",
      contractId: id,
      jobId: job.id,
      pendingRecipients: contract.recipients.length,
    });
  } catch (error) {
    logger.error("Failed to start contract:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/contracts/:id/pause", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({ where: { id } });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    if (contract.status !== "IN_PROGRESS") {
      return res.status(400).json({ error: "Contract is not in progress" });
    }

    await prisma.contract.update({
      where: { id },
      data: { status: "PAUSED" },
    });

    const job = await contractQueue.getJob(`contract-${id}`);
    if (job) {
      await job.remove();
    }

    res.json({ success: true, message: "Contract paused" });
  } catch (error) {
    logger.error("Failed to pause contract:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/contracts/:id/stats", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: { recipients: true },
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const stats = {
      contractId: id,
      name: contract.name,
      status: contract.status,
      total: contract.totalCount,
      success: contract.successCount,
      failed: contract.failureCount,
      pending: contract.pendingCount,
      successRate: contract.totalCount > 0
        ? ((contract.successCount / contract.totalCount) * 100).toFixed(2) + "%"
        : "0%",
    };

    res.json(stats);
  } catch (error) {
    logger.error("Failed to get contract stats:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/contracts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({ where: { id } });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const job = await contractQueue.getJob(`contract-${id}`);
    if (job) {
      await job.remove();
    }

    await prisma.contract.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete contract:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/queues/status", async (req, res) => {
  try {
    const contractQueueCounts = await contractQueue.getJobCounts();
    const messageQueueCounts = await messageQueue.getJobCounts();

    res.json({
      contracts: {
        waiting: contractQueueCounts.waiting,
        active: contractQueueCounts.active,
        completed: contractQueueCounts.completed,
        failed: contractQueueCounts.failed,
      },
      messages: {
        waiting: messageQueueCounts.waiting,
        active: messageQueueCounts.active,
        completed: messageQueueCounts.completed,
        failed: messageQueueCounts.failed,
      },
    });
  } catch (error) {
    logger.error("Failed to get queue status:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  const used = process.memoryUsage();

  res.json({
    status: isShuttingDown ? "shutting_down" : "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    activeClients: clients.size,
    connectingClients: connectingAccounts.size,
    maxClients: CONFIG.MAX_CLIENTS,
    memory: {
      heapUsedMB: Math.round(used.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(used.heapTotal / 1024 / 1024),
      heapPercent: Math.round((used.heapUsed / used.heapTotal) * 100),
      rssMB: Math.round(used.rss / 1024 / 1024),
    },
    caches: {
      rateLimiter: rateLimiter.size,
      dailyLimits: dailyLimits.size,
      messageCounters: messageCounters.size,
      messageQueues: messageQueues.size,
      signalKeyCache: signalKeyCache.size,
    },
  });
});

// ==================== SERVER LIFECYCLE ====================

async function restoreConnectedClients() {
  try {
    const connectedAccounts = await prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
    });

    if (connectedAccounts.length === 0) {
      logger.info("No accounts to restore");
      return;
    }

    logger.info(`Restoring ${connectedAccounts.length} account(s)...`);

    // Restore with staggered delays
    for (let i = 0; i < connectedAccounts.length; i++) {
      const account = connectedAccounts[i];

      if (i > 0) {
        await sleep(3000); // 3 second delay between restores
      }

      try {
        logger.info(`Restoring: ${account.name} (${account.id})`);
        await initializeClient(account.id);
      } catch (error) {
        logger.error(`Failed to restore ${account.name}: ${error.message}`);
      }
    }

    logger.info("Restore completed");
  } catch (error) {
    logger.error("Failed to restore clients:", error.message);
  }
}

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  isShuttingDown = true;

  stopHeartbeat();
  stopWatchdog();
  if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);

  const shutdownPromises = [];

  for (const [accountId, clientInfo] of clients.entries()) {
    const promise = (async () => {
      try {
        if (clientInfo.sock) {
          clientInfo.sock.ev.removeAllListeners();
          await clientInfo.sock.end();
        }
      } catch (error) {
        logger.error(`Failed to close ${accountId}:`, error.message);
      }
    })();
    shutdownPromises.push(promise);
  }

  await Promise.race([
    Promise.all(shutdownPromises),
    new Promise(resolve => setTimeout(resolve, 10000)),
  ]);

  await prisma.$disconnect();
  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", error => {
  const errorMsg = error.message || "";
  const errorCode = error.code;

  // Ignore recoverable errors
  if (errorCode === 'ETIMEDOUT' || errorCode === 'EPIPE' || errorCode === 'ECONNRESET' ||
      errorCode === 'ENOTFOUND' || errorCode === 'ECONNREFUSED' ||
      errorMsg.includes('EPIPE') || errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('Boom') || errorMsg.includes('DisconnectReason') ||
      errorMsg.includes('Connection Closed') || errorMsg.includes('timed out')) {
    logger.warn(`Network error (${errorCode}): ${errorMsg}`);
    return;
  }

  logger.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  const errorMsg = reason?.message || "";
  const errorCode = reason?.code;

  if (errorCode === 'ETIMEDOUT' || errorCode === 'EPIPE' || errorCode === 'ECONNRESET' ||
      errorMsg.includes('EPIPE') || errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('timed out') || errorMsg.includes('Connection Closed')) {
    logger.warn(`Unhandled rejection (${errorCode}): ${errorMsg}`);
    return;
  }

  logger.error("Unhandled rejection:", reason);
});

// Resource monitor
setInterval(() => {
  const used = process.memoryUsage();
  logger.info({
    clients: clients.size,
    connecting: connectingAccounts.size,
    memoryMB: Math.round(used.heapUsed / 1024 / 1024),
    memoryPercent: Math.round((used.heapUsed / used.heapTotal) * 100),
    uptime: Math.round(process.uptime() / 60),
  }, "Status");
}, CONFIG.RESOURCE_MONITOR_INTERVAL);

// ==================== SERVER START ====================

const PORT = process.env.API_PORT || 5001;
const server = app.listen(PORT, async () => {
  logger.info(`WhatsApp API Server on port ${PORT}`);
  logger.info(`Max clients: ${CONFIG.MAX_CLIENTS}`);

  initializeWorkers({
    clients,
    logger,
    CONFIG,
    checkRateLimit,
    checkDailyLimit,
    checkNeedRest,
    sendMessageWithHumanBehavior,
    messageCounters,
    dailyLimits,
  });

  try {
    const updated = await prisma.whatsAppAccount.updateMany({
      where: {
        status: { in: ["CONNECTING", "QR_READY", "AUTHENTICATING"] },
      },
      data: { status: "DISCONNECTED", qrCode: null },
    });

    if (updated.count > 0) {
      logger.info(`Reset ${updated.count} stuck accounts`);
    }
  } catch (error) {
    if (error.code !== "P2021") {
      logger.error("Failed to reset accounts:", error.message);
    }
  }

  startHeartbeat();
  startMemoryMonitor();
  startWatchdog();
  startCleanupRoutine();

  await restoreConnectedClients();

  logger.info("Ready");

  if (process.send) {
    process.send('ready');
  }
});
