module.exports = function(io, { clients, prisma, logger }) {
  const qrNS = io.of('/qr');

  qrNS.on('connection', (socket) => {
    logger.info(`[QR NS] Connected: ${socket.id}`);

    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.debug(`[QR NS] Socket ${socket.id} joined account:${accountId}`);
    });

    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.debug(`[QR NS] Socket ${socket.id} left account:${accountId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`[QR NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error(`[QR NS] Socket error:`, error);
    });
  });

  return qrNS;
};
