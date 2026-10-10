const prisma = require("./db");
const { redisConnection } = require("./queue");
const { CONFIG, randomDelay } = require("./config");

// ==================== ACCOUNT SETTINGS CACHE ====================
// The send path used to hit Postgres 5x per message just to read `useLimits`.

const ACCOUNT_CACHE_TTL = 60000;
const accountCache = new Map();

async function getAccountSettings(accountId) {
  const cached = accountCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { id: true, useLimits: true, createdAt: true },
  });

  accountCache.set(accountId, { value, expiresAt: Date.now() + ACCOUNT_CACHE_TTL });
  return value;
}

function invalidateAccount(accountId) {
  accountCache.delete(accountId);
}

function isNewAccount(account) {
  return Date.now() - new Date(account.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000;
}

function dailyLimitFor(account) {
  return isNewAccount(account)
    ? CONFIG.DAILY_MESSAGE_LIMIT_NEW_ACCOUNT
    : CONFIG.DAILY_MESSAGE_LIMIT_OLD_ACCOUNT;
}

// ==================== DAILY LIMITS (Redis, survives restarts) ====================

function localDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dailyKey(accountId) {
  return `wa:daily:${accountId}:${localDate()}`;
}

function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 5, 0);
  return midnight.getTime() - now.getTime();
}

async function getDailyCount(accountId) {
  return parseInt(await redisConnection.get(dailyKey(accountId)), 10) || 0;
}

async function incrementDailyCount(accountId) {
  const key = dailyKey(accountId);
  const count = await redisConnection.incr(key);
  if (count === 1) {
    await redisConnection.expire(key, 2 * 24 * 60 * 60);
  }
  return count;
}

async function checkDailyLimit(accountId) {
  const account = await getAccountSettings(accountId);
  if (!account) {
    return { allowed: false, reason: "Account not found" };
  }

  const dailyCount = await getDailyCount(accountId);
  const newAccount = isNewAccount(account);
  const dailyLimit = dailyLimitFor(account);

  // If useLimits is false, always allow
  if (!account.useLimits) {
    return { allowed: true, isNewAccount: newAccount, noLimits: true, dailyCount, dailyLimit };
  }

  if (dailyCount >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily limit reached (${dailyLimit} messages)`,
      isNewAccount: newAccount,
      dailyCount,
      dailyLimit,
      retryIn: msUntilMidnight(),
    };
  }

  return { allowed: true, isNewAccount: newAccount, dailyCount, dailyLimit };
}

// ==================== PACING (per account, in memory) ====================
// Each account has exactly one send worker, so this state never races.

const pacing = new Map();

function getPacing(accountId) {
  let state = pacing.get(accountId);
  if (!state) {
    state = { sentAt: [], sinceRest: 0, restUntil: 0, nextAllowedAt: 0 };
    pacing.set(accountId, state);
  }
  return state;
}

// Milliseconds the account has to wait before it may send the next message
function msUntilAllowed(accountId, account) {
  if (!account || !account.useLimits) return 0;

  const state = getPacing(accountId);
  const now = Date.now();

  state.sentAt = state.sentAt.filter(t => now - t < CONFIG.RATE_LIMIT_WINDOW);
  let wait = Math.max(0, state.nextAllowedAt - now);

  if (state.sentAt.length >= CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    wait = Math.max(wait, state.sentAt[0] + CONFIG.RATE_LIMIT_WINDOW - now);
  }

  return wait;
}

// Records a successful send and returns the pause before the next one
function registerSend(accountId, account) {
  if (!account || !account.useLimits) return { delay: 0, resting: false };

  const state = getPacing(accountId);
  const now = Date.now();
  state.sentAt.push(now);
  state.sinceRest++;

  let delay;
  let resting = false;
  if (state.sinceRest >= CONFIG.REST_AFTER_MESSAGES) {
    delay = randomDelay(CONFIG.REST_DURATION_MIN, CONFIG.REST_DURATION_MAX);
    state.sinceRest = 0;
    state.restUntil = now + delay;
    resting = true;
  } else {
    delay = randomDelay(CONFIG.DELAY_BETWEEN_MESSAGES_MIN, CONFIG.DELAY_BETWEEN_MESSAGES_MAX);
  }

  state.nextAllowedAt = now + delay;
  return { delay, resting };
}

function getPacingStatus(accountId) {
  const state = getPacing(accountId);
  return {
    isResting: state.restUntil > Date.now(),
    messagesSinceRest: state.sinceRest,
    nextAllowedAt: state.nextAllowedAt > Date.now() ? new Date(state.nextAllowedAt).toISOString() : null,
  };
}

function clearAccountState(accountId) {
  pacing.delete(accountId);
  accountCache.delete(accountId);
}

module.exports = {
  getAccountSettings,
  invalidateAccount,
  dailyLimitFor,
  checkDailyLimit,
  getDailyCount,
  incrementDailyCount,
  msUntilAllowed,
  registerSend,
  getPacingStatus,
  clearAccountState,
};
