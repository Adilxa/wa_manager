const { Queue, Worker, QueueEvents } = require("bullmq");
const Redis = require("ioredis");

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// Only add password if it's set
if (process.env.REDIS_PASSWORD) {
  redisConfig.password = process.env.REDIS_PASSWORD;
}

const redisConnection = new Redis(redisConfig);

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

// Queue events for monitoring - create new connections without password warnings
const contractQueueEvents = new QueueEvents("contracts", {
  connection: redisConfig,
});

const messageQueueEvents = new QueueEvents("messages", {
  connection: redisConfig,
});

module.exports = {
  contractQueue,
  messageQueue,
  contractQueueEvents,
  messageQueueEvents,
  redisConnection,
};
