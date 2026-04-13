const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

async function initSocketIO(httpServer, dependencies) {
  const { clients, prisma, logger } = dependencies;

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Redis adapter for future scaling
  const pubClient = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  });

  const subClient = pubClient.duplicate();

  io.adapter(createAdapter(pubClient, subClient));

  logger.info('Socket.IO initialized with Redis adapter');

  // Initialize namespaces
  require('./namespaces/accounts')(io, { clients, prisma, logger });
  require('./namespaces/chats')(io, { clients, prisma, logger });
  require('./namespaces/qr')(io, { clients, prisma, logger });

  // Global error handler
  io.on('error', (error) => {
    logger.error('Socket.IO error:', error);
  });

  return io;
}

module.exports = { initSocketIO };
