module.exports = function(io, { clients, prisma, logger }) {
  const accountsNS = io.of('/accounts');

  accountsNS.on('connection', (socket) => {
    logger.info(`[Accounts NS] Connected: ${socket.id}`);

    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.debug(`[Accounts NS] Socket ${socket.id} joined account:${accountId}`);
    });

    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.debug(`[Accounts NS] Socket ${socket.id} left account:${accountId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`[Accounts NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error(`[Accounts NS] Socket error:`, error);
    });
  });

  return accountsNS;
};
