const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const net = require("net");
const { PrismaClient } = require("@prisma/client");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const { contractQueue, removeSendQueue, closeQueues } = require("./queue");
const {
  initializeWorkers,
  closeWorkers,
  ensureSendWorker,
  stopSendWorker,
  enqueueContract,
  enqueueRecipient,
  enqueueDirectMessage,
  getSendQueueInfo,
} = require("./workers");
const {
  getAccountSettings,
  invalidateAccount,
  checkDailyLimit,
  getPacingStatus,
  clearAccountState,
} = require("./limits");
const { initSocketIO } = require("./socket");
const {
  clearLidMappings,
  isLidJid,
  jidUser,
  rememberContactLidMapping,
  rememberLidMapping,
  rememberMessageKeyLidMappings,
  resolveSendRecipient,
} = require("./jid-resolver");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

// ==================== PRISMA WITH AUTO-RECONNECT ====================

let prisma = null;
let prismaConnected = false;
let prismaReconnectAttempts = 0;
const MAX_PRISMA_RECONNECT_ATTEMPTS = 10;
const PRISMA_RECONNECT_DELAY = 5000;
const DB_HEALTH_CHECK_INTERVAL = 60000; // Check DB connection every minute
const DB_CONNECT_TIMEOUT = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || "20000", 10);

function createPrismaClient() {
  return new PrismaClient({
    log: ["error"],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });
}

async function connectPrisma() {
  const nextPrisma = createPrismaClient();

  try {
    const connectAndPing = async () => {
      await nextPrisma.$connect();
      await nextPrisma.$queryRaw`SELECT 1`;
    };

    await Promise.race([
      connectAndPing(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`PostgreSQL connect timed out after ${DB_CONNECT_TIMEOUT}ms`)), DB_CONNECT_TIMEOUT)
      ),
    ]);

    prisma = nextPrisma;
    prismaConnected = true;
    prismaReconnectAttempts = 0;
    console.log("[DB] PostgreSQL connected successfully");
    return true;
  } catch (error) {
    nextPrisma.$disconnect().catch(() => {});
    prismaConnected = false;
    console.error("[DB] PostgreSQL connection failed:", error.message);
    return false;
  }
}

async function reconnectPrisma() {
  if (prismaReconnectAttempts >= MAX_PRISMA_RECONNECT_ATTEMPTS) {
    console.error("[DB] Max reconnection attempts reached. Manual intervention required.");
    return false;
  }

  prismaReconnectAttempts++;
  console.log(`[DB] Attempting to reconnect (${prismaReconnectAttempts}/${MAX_PRISMA_RECONNECT_ATTEMPTS})...`);

  const connected = await connectPrisma();

  if (!connected) {
    setTimeout(reconnectPrisma, PRISMA_RECONNECT_DELAY * prismaReconnectAttempts);
  }

  return connected;
}

// Wrapper for database operations with auto-retry
async function withDbRetry(operation, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!prismaConnected) {
        await reconnectPrisma();
      }
      return await operation();
    } catch (error) {
      const isConnectionError =
        error.message?.includes("Authentication failed") ||
        error.message?.includes("Connection refused") ||
        error.message?.includes("Connection closed") ||
        error.message?.includes("Can't reach database") ||
        error.code === "P1001" || // Can't reach database server
        error.code === "P1002" || // Database server timed out
        error.code === "P1008" || // Operations timed out
        error.code === "P1017";   // Server closed the connection

      if (isConnectionError) {
        console.error(`[DB] Connection error on attempt ${attempt}:`, error.message);
        prismaConnected = false;

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          await reconnectPrisma();
          continue;
        }
      }

      throw error;
    }
  }
}

// Periodic DB health check
function startDbHealthCheck() {
  const check = async () => {
    try {
      if (!prisma) {
        await reconnectPrisma();
        return;
      }

      await prisma.$queryRaw`SELECT 1`;
      if (!prismaConnected) {
        prismaConnected = true;
        prismaReconnectAttempts = 0;
        console.log("[DB] Connection restored");
      }
    } catch (error) {
      console.error("[DB] Health check failed:", error.message);
      prismaConnected = false;
      reconnectPrisma();
    }
  };

  check();
  setInterval(check, DB_HEALTH_CHECK_INTERVAL);

  console.log(`[DB] Health check started (interval: ${DB_HEALTH_CHECK_INTERVAL / 1000}s)`);
}

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

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "25mb" }));

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
  // Thresholds are percentage of API_MEMORY_LIMIT_MB/NODE_OPTIONS heap, not current heap
  MEMORY_CHECK_INTERVAL: 30000, // Check every 30 seconds
  MEMORY_WARNING_THRESHOLD: 0.50,
  MEMORY_CRITICAL_THRESHOLD: 0.70,
  MEMORY_EMERGENCY_THRESHOLD: 0.85,

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
  MAX_CLIENTS: parseInt(process.env.MAX_CLIENTS || "150", 10), // Maximum concurrent clients
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

    // WebSocket emit for real-time status updates
    if (global.io) {
      global.io.of('/accounts')
        .to(`account:${accountId}`)
        .emit('account:status', {
          accountId,
          status,
          phoneNumber: data.phoneNumber || null,
          timestamp: new Date().toISOString()
        });
    }
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
// Per-account pacing, rate and daily limits live in ./limits (daily counter in Redis)
// and are enforced by the per-account BullMQ send workers in ./workers.

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
  clearLidMappings(accountId);
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

    // Baileys pings WhatsApp itself (keepAliveIntervalMs) and closes dead sockets; here we only
    // check the socket is still open. The old presence "available" ping kept every account online.
    for (const [accountId, clientInfo] of clients.entries()) {
      if (clientInfo.status !== "CONNECTED") continue;

      if (clientInfo.sock?.ws?.isOpen) {
        clientInfo.lastHeartbeat = Date.now();
        checkedCount++;
        continue;
      }

      logger.warn(`Heartbeat: socket for ${accountId} is not open, reconnecting`);
      clientInfo.status = "DISCONNECTED";
      await updateAccountStatus(accountId, "DISCONNECTED");
      await cleanupClient(accountId);
      await reconnectWithBackoff(accountId);
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

function getConfiguredMemoryLimitMb() {
  const explicitLimit = parseInt(process.env.API_MEMORY_LIMIT_MB || "", 10);
  if (Number.isFinite(explicitLimit) && explicitLimit > 0) {
    return explicitLimit;
  }

  const maxOldSpaceMatch = (process.env.NODE_OPTIONS || "").match(/--max-old-space-size=(\d+)/);
  if (maxOldSpaceMatch) {
    return parseInt(maxOldSpaceMatch[1], 10);
  }

  return 5120;
}

function startMemoryMonitor() {
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
  }

  const MAX_HEAP_MB = getConfiguredMemoryLimitMb();
  const warningFloorMb = Math.max(2500, Math.round(MAX_HEAP_MB * 0.35));
  const criticalFloorMb = Math.max(3500, Math.round(MAX_HEAP_MB * 0.50));
  const emergencyFloorMb = Math.max(4300, Math.round(MAX_HEAP_MB * 0.65));

  memoryMonitorInterval = setInterval(async () => {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);
    // Use RSS (actual memory) compared to max heap, not current heap
    const heapPercent = rssMB / MAX_HEAP_MB;

    // Emergency - disconnect clients to save memory (only if using significant memory)
    if (heapPercent > CONFIG.MEMORY_EMERGENCY_THRESHOLD && rssMB > emergencyFloorMb) {
      logger.error(`EMERGENCY: Memory at ${rssMB}MB / ${MAX_HEAP_MB}MB (${Math.round(heapPercent * 100)}%)`);

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
    // Critical - cleanup and GC (only if using significant memory)
    else if (heapPercent > CONFIG.MEMORY_CRITICAL_THRESHOLD && rssMB > criticalFloorMb) {
      logger.error(`CRITICAL: Memory at ${rssMB}MB / ${MAX_HEAP_MB}MB (${Math.round(heapPercent * 100)}%)`);
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
    // Warning - just cleanup and GC (only if using significant memory)
    else if (heapPercent > CONFIG.MEMORY_WARNING_THRESHOLD && rssMB > warningFloorMb) {
      logger.warn(`WARNING: Memory at ${rssMB}MB / ${MAX_HEAP_MB}MB (${Math.round(heapPercent * 100)}%)`);
      cleanupMaps();
      forceGC();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL);

  logger.info(`Memory monitor started (limit: ${MAX_HEAP_MB}MB)`);
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

// ==================== LID / PHONE NUMBER RESOLUTION ====================

async function hydrateLidMappingsFromMessages(accountId) {
  try {
    if (!prismaConnected || !prisma) return;

    const messages = await prisma.message.findMany({
      where: {
        accountId,
        chatId: { contains: "@lid" },
        contactNumber: { not: null },
      },
      select: {
        chatId: true,
        contactNumber: true,
      },
      orderBy: { sentAt: "desc" },
      take: 5000,
    });

    let loaded = 0;
    for (const msg of messages) {
      if (!msg.chatId || !msg.contactNumber) continue;
      if (msg.contactNumber === jidUser(msg.chatId)) continue;

      const mapping = rememberLidMapping(accountId, msg.chatId, msg.contactNumber, "message-cache");
      if (mapping?.changed) loaded++;
    }

    if (loaded > 0) {
      logger.info(`Loaded ${loaded} LID mappings for ${accountId} from message cache`);
    }
  } catch (error) {
    logger.warn(`Failed to hydrate LID mappings for ${accountId}: ${error.message}`);
  }
}

async function persistLidMappingToMessages(accountId, mapping) {
  if (!mapping?.changed || !prismaConnected || !prisma) return;

  const contactNumber = jidUser(mapping.pnJid);

  try {
    const [incoming, outgoing] = await Promise.all([
      prisma.message.updateMany({
        where: {
          accountId,
          chatId: mapping.lidJid,
          direction: "INCOMING",
        },
        data: {
          contactNumber,
          from: contactNumber,
        },
      }),
      prisma.message.updateMany({
        where: {
          accountId,
          chatId: mapping.lidJid,
          direction: "OUTGOING",
        },
        data: {
          contactNumber,
          to: contactNumber,
        },
      }),
    ]);

    logger.info(
      `Mapped ${mapping.lidJid} -> ${mapping.pnJid} for ${accountId} (${mapping.source}, updated ${incoming.count + outgoing.count} messages)`
    );
  } catch (error) {
    logger.warn(`Failed to persist LID mapping ${mapping.lidJid}: ${error.message}`);
  }
}

function cacheLidMapping(accountId, lid, pn, source) {
  const mapping = rememberLidMapping(accountId, lid, pn, source);
  if (mapping?.changed) {
    persistLidMappingToMessages(accountId, mapping).catch(() => {});
  }
  return mapping;
}

function cacheContactLidMapping(accountId, contact, source) {
  const mapping = rememberContactLidMapping(accountId, contact, source);
  if (mapping?.changed) {
    persistLidMappingToMessages(accountId, mapping).catch(() => {});
  }
  return mapping;
}

function cacheMessageKeyLidMappings(accountId, key, source) {
  const mappings = rememberMessageKeyLidMappings(accountId, key, source);
  for (const mapping of mappings) {
    if (mapping.changed) {
      persistLidMappingToMessages(accountId, mapping).catch(() => {});
    }
  }
  return mappings;
}

// ==================== MESSAGE QUEUE SYSTEM ====================
// Chat messages go through the account's persistent BullMQ send queue (see ./workers),
// so they survive restarts and share pacing/limits with broadcasts.

async function enqueueMessage(accountId, to, message, metadata = {}) {
  const job = await enqueueDirectMessage(accountId, to, message, metadata);
  return job.id;
}

// Kept for the socket namespaces' API; sending is driven by the BullMQ worker now
function processMessageQueue() {}

// Sends one message. Pauses *between* messages are applied by the send worker outside the job,
// so this only covers the "think + type" part.
async function sendMessageWithHumanBehavior(accountId, jid, message) {
  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    throw new Error("Client not connected");
  }

  const account = await getAccountSettings(accountId);

  if (account && account.useLimits) {
    await sleep(randomDelay(CONFIG.DELAY_BEFORE_TYPING_MIN, CONFIG.DELAY_BEFORE_TYPING_MAX));

    try {
      await clientInfo.sock.sendPresenceUpdate("composing", jid);
    } catch (err) {
      // Ignore presence errors
    }

    await sleep(calculateTypingDelay(message));

    try {
      await clientInfo.sock.sendPresenceUpdate("paused", jid);
    } catch (err) {
      // Ignore presence errors
    }

    await sleep(randomDelay(200, 800));
  }

  // The socket may have dropped while we were "typing"
  const current = clients.get(accountId);
  if (!current || current.status !== "CONNECTED" || !current.sock) {
    throw new Error("Client not connected");
  }

  const sentMessage = await current.sock.sendMessage(jid, { text: message });
  current.lastActivity = Date.now();
  return sentMessage;
}

// fetchLatestBaileysVersion() is an HTTP call — do it once per process, not on every (re)connect
let baileysVersionPromise = null;
function getBaileysVersion() {
  if (!baileysVersionPromise) {
    baileysVersionPromise = fetchLatestBaileysVersion()
      .then(({ version }) => version)
      .catch(error => {
        baileysVersionPromise = null;
        throw error;
      });
  }
  return baileysVersionPromise;
}

const WA_STATUS_MAP = { 2: "SENT", 3: "DELIVERED", 4: "READ" };

// Connects the account if needed and waits up to `timeoutMs`; returns the resulting client status
async function ensureConnected(accountId, timeoutMs = 15000) {
  const clientInfo = clients.get(accountId);
  if (clientInfo?.status === "CONNECTED") return "CONNECTED";

  if (!clientInfo || clientInfo.status === "DISCONNECTED" || clientInfo.status === "FAILED") {
    if (!connectingAccounts.has(accountId)) {
      if (clientInfo) await cleanupClient(accountId);
      await initializeClient(accountId);
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = clients.get(accountId)?.status;
    if (status === "CONNECTED" || status === "QR_READY" || !clients.has(accountId)) {
      return status || "DISCONNECTED";
    }
    await sleep(500);
  }
  return clients.get(accountId)?.status || "DISCONNECTED";
}

// ==================== WHATSAPP CLIENT INITIALIZATION ====================

async function initializeClient(accountId) {
  if (process.env.ENABLE_WHATSAPP_CLIENTS !== "true") {
    throw new Error("WhatsApp client initialization is disabled");
  }

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

  let account;
  try {
    account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      const notFound = new Error("Account not found");
      notFound.statusCode = 404;
      throw notFound;
    }
  } catch (dbError) {
    if (dbError.statusCode !== 404) {
      logger.error(`Database error for ${accountId}: ${dbError.message}`);
    }
    throw dbError;
  }

  logger.info(`Initializing client for ${accountId}`);

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

    const version = await getBaileysVersion();

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    await hydrateLidMappingsFromMessages(accountId);

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
      // Used by WhatsApp retry receipts: must return the original text, otherwise
      // the recipient can end up with an empty message
      getMessage: async key => {
        if (!key?.id || !prismaConnected || !prisma) return undefined;
        const stored = await prisma.message.findUnique({
          where: { accountId_waMessageId: { accountId, waMessageId: key.id } },
          select: { message: true },
        });
        return stored ? { conversation: stored.message } : undefined;
      },
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

          // WebSocket emit for real-time QR delivery
          if (global.io) {
            global.io.of('/qr')
              .to(`account:${accountId}`)
              .emit('qr:generated', {
                accountId,
                qrCode: qrDataUrl,
                expiresIn: 45,
                timestamp: new Date().toISOString()
              });
          }

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
      } else if (connection === "connecting") {
        clientInfo.status = "AUTHENTICATING";
        await updateAccountStatus(accountId, "AUTHENTICATING");
      }
    });

    // Save credentials
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("contacts.upsert", contacts => {
      for (const contact of contacts || []) {
        cacheContactLidMapping(accountId, contact, "contacts.upsert");
      }
    });

    sock.ev.on("messaging-history.set", ({ contacts }) => {
      for (const contact of contacts || []) {
        cacheContactLidMapping(accountId, contact, "messaging-history.set");
      }
    });

    sock.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
      cacheLidMapping(accountId, lid, jid, "chats.phoneNumberShare");
    });

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
          const isFromMe = msg.key.fromMe;
          const isGroup = chatId.endsWith("@g.us");
          cacheMessageKeyLidMappings(accountId, msg.key, "messages.upsert");

          // For groups, get the actual sender from participant
          // participant can be: "77001234567@s.whatsapp.net" or "77001234567:123@s.whatsapp.net" (with device id)
          // or LID format: "123456789@lid"
          let senderJid = null;
          let senderNumber = null;

          if (isGroup && !isFromMe) {
            // Get participant (actual sender in group)
            senderJid = msg.key.participantPn || msg.key.participant || msg.participant;
            if (senderJid) {
              // Extract number: remove @s.whatsapp.net or @lid, and device id if present
              senderNumber = senderJid.split("@")[0].split(":")[0];
            }
          }

          // For direct chats or outgoing messages, use chatId
          const directContactNumber = !isGroup && !isFromMe && msg.key.senderPn
            ? jidUser(msg.key.senderPn)
            : null;
          const contactNumber = senderNumber || directContactNumber || jidUser(chatId);

          // upsert on (accountId, waMessageId): WhatsApp re-delivers messages after reconnects
          const messageData = {
              accountId,
              chatId,
              waMessageId: msg.key.id || null,
              direction: isFromMe ? "OUTGOING" : "INCOMING",
              message: messageText,
              to: isFromMe ? contactNumber : null,
              from: isFromMe ? null : contactNumber,
              status: isFromMe ? "SENT" : "RECEIVED",
              contactNumber,
              contactName: msg.pushName || null,
          };
          const dbMessage = messageData.waMessageId
            ? await prisma.message.upsert({
                where: { accountId_waMessageId: { accountId, waMessageId: messageData.waMessageId } },
                create: messageData,
                update: {},
              })
            : await prisma.message.create({ data: messageData });

          // WebSocket emit for real-time message delivery
          if (global.io) {
            global.io.of('/chats')
              .to(`account:${accountId}`)
              .emit('chat:message:new', {
                accountId,
                chatId,
                message: dbMessage
              });
          }

          // Log for debugging group messages
          if (isGroup) {
            logger.debug(`Group msg in ${chatId} from ${senderJid} (${contactNumber}): ${messageText.substring(0, 50)}`);
          }
        } catch (error) {
          logger.error(`Failed to save message for ${accountId}:`, error.message);
        }
      }
    });

    // Delivery / read receipts for messages we sent
    sock.ev.on("messages.update", async updates => {
      clientInfo.lastActivity = Date.now();

      for (const update of updates || []) {
        const newStatus = WA_STATUS_MAP[update.update?.status];
        if (!newStatus || !update.key?.id || !update.key.fromMe) continue;

        try {
          await prisma.message.updateMany({
            where: { accountId, waMessageId: update.key.id },
            data: { status: newStatus },
          });
        } catch (error) {
          logger.debug(`Failed to update message status: ${error.message}`);
        }
      }
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

function getPublicClientStatus(account, clientStatus) {
  if (clientStatus?.status) {
    return clientStatus.status;
  }

  if (process.env.ENABLE_WHATSAPP_CLIENTS !== "true" && account.status === "CONNECTED") {
    return "DISCONNECTED";
  }

  return account.status;
}

function withPublicClientStatus(account) {
  const clientStatus = clients.get(account.id);

  return {
    ...account,
    clientStatus: getPublicClientStatus(account, clientStatus),
    hasActiveClient: !!clientStatus,
    lastHeartbeat: clientStatus?.lastHeartbeat || null,
    latency: clientStatus?.latency || null,
  };
}

// Get all accounts
app.get("/api/accounts", async (req, res) => {
  try {
    if (!prismaConnected || !prisma) {
      return res.status(503).json({ error: "Database is not connected" });
    }

    const timeoutMs = parseInt(process.env.DB_QUERY_TIMEOUT_MS || "15000", 10);
    const accountsQuery = prisma.whatsAppAccount.findMany({
      orderBy: { createdAt: "desc" },
    });
    accountsQuery.catch(() => {});

    const accounts = await Promise.race([
      accountsQuery,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`accounts query timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    const accountsWithClientStatus = accounts.map(withPublicClientStatus);

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
    ensureSendWorker(account.id);
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

    res.json(withPublicClientStatus(account));
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
    invalidateAccount(id);

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

    if (process.env.ENABLE_WHATSAPP_CLIENTS !== "true") {
      return res.status(503).json({ error: "WhatsApp client initialization is disabled" });
    }

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
    if (error.statusCode === 404) {
      logger.debug(`Connect requested for unknown account ${req.params.id}`);
      return res.status(404).json({ error: "Account not found" });
    }
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

    // Drop the account's send worker and its queued messages
    await stopSendWorker(accountId);
    await removeSendQueue(accountId).catch(err =>
      logger.error(`Failed to remove send queue for ${accountId}: ${err.message}`)
    );
    clearAccountState(accountId);

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

// Auto-connects the account for the send endpoints. Returns an error { code, body } or null.
async function autoConnectForSend(accountId) {
  if (clients.get(accountId)?.status === "CONNECTED") return null;

  const account = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) {
    return { code: 404, body: { error: "Account not found" } };
  }

  try {
    const status = await ensureConnected(accountId);
    if (status !== "CONNECTED") {
      return {
        code: 503,
        body: { error: "Account is connecting. Try again in a few seconds.", status },
      };
    }
    return null;
  } catch (connectError) {
    return {
      code: 503,
      body: { error: "Failed to connect account", details: connectError.message },
    };
  }
}

// Send message via BullMQ (per-account send queue, ahead of broadcast messages)
app.post("/api/messages/send", async (req, res) => {
  try {
    const { accountId, to, message } = req.body;

    if (!accountId || !to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const connectError = await autoConnectForSend(accountId);
    if (connectError) {
      return res.status(connectError.code).json(connectError.body);
    }

    const tempContract = await prisma.contract.create({
      data: {
        accountId,
        name: `Single message to ${to}`,
        totalCount: 1,
        pendingCount: 1,
        status: "IN_PROGRESS",
        startedAt: new Date(),
        recipients: {
          create: { phoneNumber: to, message, status: "QUEUED" },
        },
      },
      include: { recipients: true },
    });

    const recipient = tempContract.recipients[0];
    const job = await enqueueRecipient(accountId, tempContract.id, recipient);
    const info = await getSendQueueInfo(accountId);

    res.status(202).json({
      success: true,
      queued: true,
      messageId: tempContract.id,
      contractId: tempContract.id,
      recipientId: recipient.id,
      jobId: job.id,
      queuePosition: Math.max(1, info.counts.waiting),
      queueLength: info.queueLength,
      message: "Message queued for delivery",
    });
  } catch (error) {
    logger.error(`Failed to queue message: ${error.message}`);
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
      const key = msg.chatId || msg.contactNumber || msg.to || msg.from;
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

    const connectError = await autoConnectForSend(accountId);
    if (connectError) {
      return res.status(connectError.code).json(connectError.body);
    }

    const messageId = await enqueueMessage(accountId, decodedChatId, message, {
      chatId: decodedChatId,
    });
    const info = await getSendQueueInfo(accountId);

    res.status(202).json({
      success: true,
      queued: true,
      messageId,
      queuePosition: Math.max(1, info.counts.waiting),
      queueLength: info.queueLength,
      message: "Message queued for delivery",
    });
  } catch (error) {
    logger.error(`Failed to queue chat message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Queue status
app.get("/api/accounts/:id/queue", async (req, res) => {
  try {
    const { id } = req.params;

    const [info, dailyCheck] = await Promise.all([getSendQueueInfo(id), checkDailyLimit(id)]);

    res.json({
      accountId: id,
      queueLength: info.queueLength,
      counts: info.counts,
      messages: info.messages,
      status: {
        clientStatus: clients.get(id)?.status || "DISCONNECTED",
        ...getPacingStatus(id),
      },
      limits: {
        dailyCount: dailyCheck.dailyCount || 0,
        dailyLimit: dailyCheck.dailyLimit,
        useLimits: !dailyCheck.noLimits,
      },
    });
  } catch (error) {
    logger.error(`Failed to get queue status: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONTRACT API ROUTES ====================

// Moves FAILED recipients back to PENDING, marks the contract IN_PROGRESS and queues the fan-out
async function startContract(id) {
  const retried = await prisma.$transaction(async tx => {
    const { count } = await tx.contractRecipient.updateMany({
      where: { contractId: id, status: "FAILED" },
      data: { status: "PENDING", errorMessage: null },
    });

    await tx.contract.update({
      where: { id },
      data: {
        status: "IN_PROGRESS",
        completedAt: null,
        ...(count > 0
          ? { failureCount: { decrement: count }, pendingCount: { increment: count } }
          : {}),
      },
    });

    await tx.contract.updateMany({
      where: { id, startedAt: null },
      data: { startedAt: new Date() },
    });

    return count;
  });

  const job = await enqueueContract(id);
  return { job, retried };
}

// Create a contract. Recipients are inserted in batches; pass autoStart: true to start right away.
app.post("/api/contracts", async (req, res) => {
  try {
    const { accountId, name, recipients, autoStart = false } = req.body;

    if (!accountId || !name || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    for (const recipient of recipients) {
      if (!recipient || !recipient.phoneNumber || !recipient.message) {
        return res.status(400).json({ error: "Each recipient must have phoneNumber and message" });
      }
    }

    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    const created = await prisma.$transaction(
      async tx => {
        const contract = await tx.contract.create({
          data: {
            accountId,
            name,
            totalCount: recipients.length,
            pendingCount: recipients.length,
            status: "PENDING",
          },
        });

        for (let i = 0; i < recipients.length; i += 1000) {
          await tx.contractRecipient.createMany({
            data: recipients.slice(i, i + 1000).map(r => ({
              contractId: contract.id,
              phoneNumber: String(r.phoneNumber),
              message: String(r.message),
              status: "PENDING",
            })),
          });
        }

        return contract;
      },
      { timeout: 120000 }
    );

    if (autoStart) {
      await startContract(created.id);
    }

    // Recipients are echoed back only for contracts up to 1000 (use GET /api/contracts/:id to page)
    const contract = await prisma.contract.findUnique({
      where: { id: created.id },
      include:
        recipients.length <= 1000 ? { recipients: { orderBy: { createdAt: "asc" } } } : undefined,
    });

    logger.info(`Created contract: ${contract.id} with ${recipients.length} recipients`);
    res.status(201).json(contract);
  } catch (error) {
    logger.error(`Failed to create contract: ${error.message}`);
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
    logger.error(`Failed to get contracts: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Contract details; recipients are paginated (?page=1&limit=1000, &status=FAILED to filter)
app.get("/api/contracts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
    const recipientWhere = req.query.status ? { status: String(req.query.status) } : {};

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        account: {
          select: { id: true, name: true, phoneNumber: true },
        },
        recipients: {
          where: recipientWhere,
          orderBy: { createdAt: "asc" },
          skip: (page - 1) * limit,
          take: limit,
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const total = await prisma.contractRecipient.count({
      where: { contractId: id, ...recipientWhere },
    });

    res.json({
      ...contract,
      recipientsPagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error(`Failed to get contract: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/contracts/:id/start", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, accountId: true },
    });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const pendingRecipients = await prisma.contractRecipient.count({
      where: { contractId: id, status: { in: ["PENDING", "QUEUED", "FAILED"] } },
    });

    if (contract.status === "COMPLETED" && pendingRecipients === 0) {
      return res.status(400).json({ error: "Contract already completed" });
    }

    if (pendingRecipients === 0) {
      return res.status(400).json({ error: "No pending recipients" });
    }

    const { job, retried } = await startContract(id);
    const accountStatus = clients.get(contract.accountId)?.status || "DISCONNECTED";

    logger.info(`Queued contract ${contract.name} (${id}), retrying ${retried} failed`);

    res.json({
      success: true,
      message: "Contract queued",
      contractId: id,
      jobId: job.id,
      pendingRecipients,
      retriedFailed: retried,
      accountStatus,
      ...(accountStatus !== "CONNECTED"
        ? { warning: "Account is not connected; messages will be sent once it connects" }
        : {}),
    });
  } catch (error) {
    logger.error(`Failed to start contract: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Pause: queued messages of this contract are skipped by the send worker and return to PENDING
app.post("/api/contracts/:id/pause", async (req, res) => {
  try {
    const { id } = req.params;

    const { count } = await prisma.contract.updateMany({
      where: { id, status: "IN_PROGRESS" },
      data: { status: "PAUSED" },
    });

    if (count === 0) {
      const exists = await prisma.contract.count({ where: { id } });
      return exists
        ? res.status(400).json({ error: "Contract is not in progress" })
        : res.status(404).json({ error: "Contract not found" });
    }

    res.json({ success: true, message: "Contract paused" });
  } catch (error) {
    logger.error(`Failed to pause contract: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/contracts/:id/stats", async (req, res) => {
  try {
    const { id } = req.params;

    const contract = await prisma.contract.findUnique({ where: { id } });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    res.json({
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
    });
  } catch (error) {
    logger.error(`Failed to get contract stats: ${error.message}`);
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

    const job = await contractQueue.getJob(`contract_${id}`);
    if (job) {
      await job.remove().catch(() => {});
    }

    // Recipients are deleted by cascade; their queued send jobs are skipped by the worker
    await prisma.contract.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    logger.error(`Failed to delete contract: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/queues/status", async (req, res) => {
  try {
    const accounts = await prisma.whatsAppAccount.findMany({ select: { id: true, name: true } });

    const [contractQueueCounts, perAccount] = await Promise.all([
      contractQueue.getJobCounts(),
      Promise.all(
        accounts.map(async a => {
          const info = await getSendQueueInfo(a.id);
          return {
            accountId: a.id,
            name: a.name,
            clientStatus: clients.get(a.id)?.status || "DISCONNECTED",
            ...info.counts,
            ...getPacingStatus(a.id),
          };
        })
      ),
    ]);

    const sum = key => perAccount.reduce((acc, q) => acc + (q[key] || 0), 0);

    res.json({
      contracts: {
        waiting: contractQueueCounts.waiting,
        prioritized: contractQueueCounts.prioritized,
        delayed: contractQueueCounts.delayed,
        active: contractQueueCounts.active,
        completed: contractQueueCounts.completed,
        failed: contractQueueCounts.failed,
      },
      messages: {
        waiting: sum("waiting"),
        prioritized: sum("prioritized"),
        delayed: sum("delayed"),
        active: sum("active"),
        failed: sum("failed"),
        accounts: perAccount,
      },
    });
  } catch (error) {
    logger.error(`Failed to get queue status: ${error.message}`);
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
    queueWorkersEnabled: process.env.START_QUEUE_WORKERS === "true",
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

app.get("/health/db-tcp", async (req, res) => {
  const host = process.env.DB_TCP_HOST || "postgres";
  const port = parseInt(process.env.DB_TCP_PORT || "5432", 10);
  const timeoutMs = parseInt(process.env.DB_TCP_TIMEOUT_MS || "3000", 10);
  const startedAt = Date.now();
  let finished = false;

  const socket = net.createConnection({ host, port });

  const finish = (status, extra = {}) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    res.status(status === "ok" ? 200 : 500).json({
      status,
      host,
      port,
      durationMs: Date.now() - startedAt,
      ...extra,
    });
  };

  socket.setTimeout(timeoutMs);
  socket.once("connect", () => finish("ok"));
  socket.once("timeout", () => finish("error", { error: `TCP connect timed out after ${timeoutMs}ms` }));
  socket.once("error", (error) => finish("error", { error: error.message, code: error.code }));
});

// WebSocket health check
app.get("/health/websocket", (req, res) => {
  if (!global.io) {
    return res.status(503).json({ error: 'WebSocket not initialized' });
  }

  res.json({
    status: 'healthy',
    connections: global.io.engine.clientsCount,
    namespaces: {
      accounts: global.io.of('/accounts').sockets.size,
      chats: global.io.of('/chats').sockets.size,
      qr: global.io.of('/qr').sockets.size
    },
    timestamp: new Date().toISOString()
  });
});

// ==================== SERVER LIFECYCLE ====================

async function restoreConnectedClients() {
  if (process.env.RESTORE_CONNECTED_CLIENTS !== "true") {
    logger.info("Skipping connected account restore (RESTORE_CONNECTED_CLIENTS is not true)");
    return;
  }

  try {
    const connectedAccounts = await prisma.whatsAppAccount.findMany({
      where: { status: "CONNECTED" },
      take: parseInt(process.env.RESTORE_CONNECTED_CLIENTS_LIMIT || "5", 10),
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
  if (isShuttingDown) return;
  logger.info(`Received ${signal}, shutting down...`);
  isShuttingDown = true;

  stopHeartbeat();
  stopWatchdog();
  if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);

  // Let in-flight sends finish (bounded) so they are not left in SENDING
  await Promise.race([closeWorkers(), sleep(20000)]);

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

  await closeQueues();
  await prisma.$disconnect();
  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", error => {
  const errorMsg = error.message || "";
  const errorCode = error.code;

  // Handle database connection errors
  if (errorMsg.includes('Authentication failed') ||
      errorMsg.includes("Can't reach database") ||
      error.code === 'P1001' || error.code === 'P1002' ||
      error.code === 'P1008' || error.code === 'P1017') {
    logger.error(`[DB] Connection lost: ${errorMsg}`);
    prismaConnected = false;
    reconnectPrisma();
    return;
  }

  // Ignore recoverable network errors
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

  // Handle database connection errors
  if (errorMsg.includes('Authentication failed') ||
      errorMsg.includes("Can't reach database") ||
      reason?.code === 'P1001' || reason?.code === 'P1002' ||
      reason?.code === 'P1008' || reason?.code === 'P1017') {
    logger.error(`[DB] Connection lost in promise: ${errorMsg}`);
    prismaConnected = false;
    reconnectPrisma();
    return;
  }

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
const httpServer = createServer(app);
let io;

const server = httpServer.listen(PORT, async () => {
  logger.info(`WhatsApp API Server on port ${PORT}`);
  logger.info(`Max clients: ${CONFIG.MAX_CLIENTS}`);
  logger.info("[DB] Connecting to PostgreSQL...");
  const initialDbConnected = await connectPrisma();
  if (!initialDbConnected) {
    logger.error("[DB] Initial PostgreSQL connection failed; API will keep running and retry in background");
    reconnectPrisma();
  }

  // Initialize Socket.IO with all dependencies
  try {
    io = await initSocketIO(httpServer, {
      clients,
      prisma,
      getPrisma: () => prisma,
      isPrismaConnected: () => prismaConnected,
      logger,
      CONFIG,
      initializeClient,
      cleanupClient,
      enqueueMessage,
      processMessageQueue,
      messageQueues,
      getSendQueueInfo,
      connectingAccounts,
      reconnectAttempts
    });
    global.io = io;
    logger.info('Socket.IO initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Socket.IO:', error);
  }

  if (process.env.START_QUEUE_WORKERS === "true") {
    try {
      await initializeWorkers({ clients, logger, sendMessageWithHumanBehavior });
    } catch (error) {
      logger.error(`Failed to initialize workers: ${error.message}`);
    }
  } else {
    logger.info("Skipping BullMQ workers (START_QUEUE_WORKERS is not true)");
  }

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
  startDbHealthCheck();

  await restoreConnectedClients();

  logger.info("Ready");

  if (process.send) {
    process.send('ready');
  }
});
