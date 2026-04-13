const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

async function initSocketIO(httpServer, dependencies) {
  const {
    clients,
    prisma,
    logger,
    initializeClient,
    cleanupClient,
    enqueueMessage,
    processMessageQueue,
    messageQueues,
    connectingAccounts,
    reconnectAttempts
  } = dependencies;

  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || '*',
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
  });

  // Redis adapter for horizontal scaling
  const redisConfig = {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };

  // Add password only if provided
  if (process.env.REDIS_PASSWORD) {
    redisConfig.password = process.env.REDIS_PASSWORD;
  }

  logger.info('[Socket.IO] Connecting to Redis...', { host: redisConfig.host, port: redisConfig.port });

  const pubClient = new Redis(redisConfig);
  const subClient = pubClient.duplicate();

  // Log Redis errors (but don't reject on them after connection is ready)
  pubClient.on('error', (err) => {
    logger.error('[Socket.IO] Redis pub client error:', err.message);
  });

  subClient.on('error', (err) => {
    logger.error('[Socket.IO] Redis sub client error:', err.message);
  });

  // Wait for Redis clients to be ready
  await Promise.all([
    new Promise((resolve, reject) => {
      if (pubClient.status === 'ready') {
        logger.info('[Socket.IO] Redis pub client already ready');
        resolve();
      } else {
        const timeout = setTimeout(() => reject(new Error('Redis pub client connection timeout')), 10000);
        pubClient.once('ready', () => {
          clearTimeout(timeout);
          logger.info('[Socket.IO] Redis pub client ready');
          resolve();
        });
      }
    }),
    new Promise((resolve, reject) => {
      if (subClient.status === 'ready') {
        logger.info('[Socket.IO] Redis sub client already ready');
        resolve();
      } else {
        const timeout = setTimeout(() => reject(new Error('Redis sub client connection timeout')), 10000);
        subClient.once('ready', () => {
          clearTimeout(timeout);
          logger.info('[Socket.IO] Redis sub client ready');
          resolve();
        });
      }
    }),
  ]);

  io.adapter(createAdapter(pubClient, subClient));

  logger.info('[Socket.IO] Redis adapter initialized successfully');

  // Prepare dependencies for namespaces
  const namespaceDeps = {
    clients,
    prisma,
    logger,
    initializeClient,
    cleanupClient,
    enqueueMessage,
    processMessageQueue,
    messageQueues,
    connectingAccounts,
    reconnectAttempts
  };

  // Initialize namespaces with full dependencies
  require('./namespaces/accounts')(io, namespaceDeps);
  require('./namespaces/chats')(io, namespaceDeps);
  require('./namespaces/qr')(io, namespaceDeps);

  // Global error handler
  io.on('error', (error) => {
    logger.error('Socket.IO error:', error);
  });

  logger.info('All WebSocket namespaces initialized');

  return io;
}

module.exports = { initSocketIO };
