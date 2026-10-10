function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

const CONFIG = {
  // Reconnection settings
  RECONNECT_MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY: 1000, // 1 second
  RECONNECT_MAX_DELAY: 300000, // 5 minutes max

  // Heartbeat settings (socket liveness is checked locally, Baileys keep-alive does the pinging)
  HEARTBEAT_INTERVAL: 30000,

  // Initialization timeout
  INIT_TIMEOUT: 120000, // 2 minutes to initialize

  // How long send endpoints wait for an auto-connect before answering 503
  AUTO_CONNECT_WAIT: 15000,

  // Rate limiting - БЕЗОПАСНЫЕ значения для избежания бана (per account)
  RATE_LIMIT_WINDOW: 60000, // 1 minute window
  RATE_LIMIT_MAX_MESSAGES: envInt("RATE_LIMIT_MAX_MESSAGES", 20),

  // Дневные лимиты (per account, persisted in Redis)
  DAILY_MESSAGE_LIMIT_NEW_ACCOUNT: envInt("DAILY_MESSAGE_LIMIT_NEW_ACCOUNT", 500), // младше 7 дней
  DAILY_MESSAGE_LIMIT_OLD_ACCOUNT: envInt("DAILY_MESSAGE_LIMIT_OLD_ACCOUNT", 1000),

  // Memory management (fractions of the V8 heap limit, not of the current heapTotal)
  MEMORY_CHECK_INTERVAL: 60000,
  MEMORY_WARNING_THRESHOLD: 0.75,
  MEMORY_CRITICAL_THRESHOLD: 0.9,

  // Retries of a single broadcast message (BullMQ attempts)
  MESSAGE_RETRY_COUNT: 3,
  MESSAGE_RETRY_DELAY: 5000,

  // How long to wait before re-checking a disconnected account that has queued messages
  NOT_CONNECTED_RETRY_DELAY: 30000,

  // Resource monitoring
  RESOURCE_MONITOR_INTERVAL: 300000, // 5 minutes

  // Human-like behavior delays (в миллисекундах)
  TYPING_SPEED_MIN: 30, // мс на символ
  TYPING_SPEED_MAX: 100,
  TYPING_MAX_DURATION: 5000, // cap so long messages don't block the account
  DELAY_BEFORE_TYPING_MIN: 500,
  DELAY_BEFORE_TYPING_MAX: 2000,
  DELAY_BETWEEN_MESSAGES_MIN: envInt("DELAY_BETWEEN_MESSAGES_MIN", 3000),
  DELAY_BETWEEN_MESSAGES_MAX: envInt("DELAY_BETWEEN_MESSAGES_MAX", 8000),
  REST_AFTER_MESSAGES: envInt("REST_AFTER_MESSAGES", 5),
  REST_DURATION_MIN: envInt("REST_DURATION_MIN", 30000),
  REST_DURATION_MAX: envInt("REST_DURATION_MAX", 120000),

  // Contracts: how many recipients are inserted / enqueued per batch
  CONTRACT_BATCH_SIZE: 1000,
};

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { CONFIG, randomDelay, sleep };
