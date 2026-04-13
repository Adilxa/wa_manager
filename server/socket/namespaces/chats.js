module.exports = function(io, { clients, prisma, logger }) {
  const chatsNS = io.of('/chats');

  chatsNS.on('connection', (socket) => {
    logger.info(`[Chats NS] Connected: ${socket.id}`);

    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.debug(`[Chats NS] Socket ${socket.id} joined account:${accountId}`);
    });

    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.debug(`[Chats NS] Socket ${socket.id} left account:${accountId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`[Chats NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error(`[Chats NS] Socket error:`, error);
    });
  });

  return chatsNS;
};
