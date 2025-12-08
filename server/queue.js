const { Queue, Worker, QueueEvents } = require("bullmq");
const Redis = require("ioredis");

// Redis connection configuration
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Create queue for contract processing
const contractQueue = new Queue("contracts", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: {
      age: 86400, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 604800, // Keep failed jobs for 7 days
    },
  },
});

// Create queue for individual message sending
const messageQueue = new Queue("messages", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // Keep for 1 hour
      count: 10000,
    },
    removeOnFail: {
      age: 86400, // Keep failed for 24 hours
    },
  },
});

// Queue events for monitoring
const contractQueueEvents = new QueueEvents("contracts", {
  connection: redisConnection,
});

const messageQueueEvents = new QueueEvents("messages", {
  connection: redisConnection,
});

module.exports = {
  contractQueue,
  messageQueue,
  contractQueueEvents,
  messageQueueEvents,
  redisConnection,
};
