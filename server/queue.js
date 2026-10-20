const { Queue } = require("bullmq");
const Redis = require("ioredis");

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Only add password if it's set
if (process.env.REDIS_PASSWORD) {
  redisConfig.password = process.env.REDIS_PASSWORD;
}

// Shared non-blocking connection (queues, counters). Workers create their own blocking ones.
const redisConnection = new Redis(redisConfig);

// Contract queue: one job per started contract, fans recipients out to the per-account send queues
const contractQueue = new Queue("contracts", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { age: 604800 }, // Keep failed jobs for 7 days
  },
});

// One send queue per WhatsApp account, so accounts send in parallel while each
// account stays strictly sequential and keeps its own pacing / rate limit.
const sendQueues = new Map();

function sendQueueName(accountId) {
  return `send_${accountId}`;
}

function getSendQueue(accountId) {
  let queue = sendQueues.get(accountId);
  if (!queue) {
    queue = new Queue(sendQueueName(accountId), {
      connection: redisConnection,
      defaultJobOptions: {
        // Retries are handled per attempt in the worker; counters are only updated on the final one
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        // Message state lives in Postgres; completed jobs are dropped so jobIds can be reused on resume
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    sendQueues.set(accountId, queue);
  }
  return queue;
}

async function removeSendQueue(accountId) {
  const queue = getSendQueue(accountId);
  sendQueues.delete(accountId);
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

async function closeQueues() {
  await Promise.allSettled([
    contractQueue.close(),
    ...Array.from(sendQueues.values()).map(q => q.close()),
  ]);
  await redisConnection.quit().catch(() => {});
}

module.exports = {
  redisConfig,
  redisConnection,
  contractQueue,
  getSendQueue,
  sendQueueName,
  removeSendQueue,
  closeQueues,
};
