const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

async function initSocketIO(httpServer, dependencies) {
  const {
    clients,
    prisma,
    getPrisma,
    isPrismaConnected,
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
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  for (const namespace of ['/accounts', '/chats', '/qr']) {
    io.of(namespace);
  }

  // Redis adapter for horizontal scaling
  const pubClient = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  });

  const subClient = pubClient.duplicate();

  io.adapter(createAdapter(pubClient, subClient));

  logger.info('Socket.IO initialized with Redis adapter');

  // Prepare dependencies for namespaces
  const namespaceDeps = {
    clients,
    prisma,
    getPrisma,
    isPrismaConnected,
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
