/**
 * WebSocket Namespace: /chats
 * Handles all chat and messaging operations
 *
 * Events:
 * - join(accountId) - Subscribe to account messages
 * - leave(accountId) - Unsubscribe from account messages
 * - chats:list({ accountId, page?, limit?, phone? }) - Get all chats
 * - chat:messages({ accountId, chatId }) - Get messages for specific chat
 * - chat:send({ accountId, chatId, message }) - Send message to chat
 * - message:send({ accountId, to, message }) - Send single message
 * - messages:history({ accountId, limit?, offset? }) - Get all messages for account
 * - queue:status({ accountId }) - Get queue status
 *
 * Room Events (emitted to account:${accountId}):
 * - chat:message:new - New incoming/outgoing message
 * - chat:message:sent - Message successfully sent
 * - chat:message:failed - Message failed to send
 */

module.exports = function(io, dependencies) {
  const { clients, prisma, logger, messageQueues, enqueueMessage, processMessageQueue, initializeClient, cleanupClient } = dependencies;
  const chatsNS = io.of('/chats');

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Normalize phone number - remove + and any non-digit characters
   * @param {string} phone - Phone number
   * @returns {string} - Normalized phone number (digits only)
   */
  function normalizePhone(phone) {
    if (!phone) return '';
    // Remove + at start and any non-digit characters
    return phone.replace(/^\+/, '').replace(/\D/g, '');
  }

  chatsNS.on('connection', (socket) => {
    logger.info(`[Chats NS] Connected: ${socket.id}`);

    // =============================================
    // ROOM MANAGEMENT
    // =============================================

    /**
     * Join account room to receive real-time message updates
     * @event join
     * @param {string} accountId - Account ID to subscribe to
     */
    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.info(`[Chats NS] Socket ${socket.id} joined room account:${accountId}`);
    });

    /**
     * Leave account room
     * @event leave
     * @param {string} accountId - Account ID to unsubscribe from
     */
    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.info(`[Chats NS] Socket ${socket.id} left room account:${accountId}`);
    });

    // =============================================
    // CHAT LIST & HISTORY
    // =============================================

    /**
     * Get all chats (grouped by contact) for an account
     * @event chats:list
     * @param {Object} data - { accountId, page?, limit?, phone? }
     * @returns {Object} - { success, data: Chat[], pagination }
     */
    socket.on('chats:list', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chats:list');
        return;
      }

      const { accountId, page = 1, limit = 50, phone } = data;

      if (!accountId) {
        return callback({ success: false, error: 'accountId is required' });
      }

      try {
        logger.info(`[Chats NS] chats:list for account: ${accountId}`);
        const pageNum = parseInt(page);
        const limitNum = Math.min(parseInt(limit), 100);
        const skip = (pageNum - 1) * limitNum;

        const where = { accountId };

        if (phone) {
          const normalizedPhone = normalizePhone(phone);
          where.OR = [
            { to: { contains: normalizedPhone } },
            { from: { contains: normalizedPhone } },
            { contactNumber: { contains: normalizedPhone } },
          ];
        }

        const messages = await prisma.message.findMany({
          where,
          orderBy: { sentAt: 'desc' },
          take: 5000,
        });

        // Group messages by contact
        const chatsMap = new Map();

        messages.forEach(msg => {
          const key = msg.contactNumber || msg.to || msg.from || msg.chatId;
          if (!key) return;

          if (!chatsMap.has(key)) {
            chatsMap.set(key, {
              chatId: msg.chatId,
              contactNumber: msg.contactNumber || msg.to || msg.from,
              contactName: msg.contactName,
              lastMessage: msg.message,
              lastMessageTime: msg.sentAt,
              lastMessageDirection: msg.direction,
              messageCount: 0,
              unreadCount: 0,
            });
          }

          const chat = chatsMap.get(key);
          chat.messageCount++;

          if (new Date(msg.sentAt) > new Date(chat.lastMessageTime)) {
            chat.lastMessageTime = msg.sentAt;
            chat.lastMessage = msg.message;
            chat.lastMessageDirection = msg.direction;
          }
        });

        let chatsArray = Array.from(chatsMap.values());
        chatsArray.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        const total = chatsArray.length;
        const paginatedChats = chatsArray.slice(skip, skip + limitNum);
        const totalPages = Math.ceil(total / limitNum);

        callback({
          success: true,
          data: paginatedChats,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages,
            hasNextPage: pageNum < totalPages,
            hasPrevPage: pageNum > 1,
          },
        });
      } catch (error) {
        logger.error('[Chats NS] chats:list error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    /**
     * Get messages for a specific chat
     * @event chat:messages
     * @param {Object} data - { accountId, chatId, limit?, offset? }
     * @returns {Object} - { success, data: Message[] }
     */
    socket.on('chat:messages', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chat:messages');
        return;
      }

      const { accountId, chatId, limit = 100, offset = 0 } = data;

      if (!accountId || !chatId) {
        return callback({ success: false, error: 'accountId and chatId are required' });
      }

      try {
        logger.info(`[Chats NS] chat:messages for ${chatId}`);

        const decodedChatId = decodeURIComponent(chatId);
        const contactNumber = normalizePhone(decodedChatId.split('@')[0]);

        // Find messages by chatId or contactNumber
        const messages = await prisma.message.findMany({
          where: {
            accountId,
            OR: [
              { chatId: decodedChatId },
              { contactNumber },
              { to: contactNumber },
              { from: contactNumber },
            ],
          },
          orderBy: { sentAt: 'asc' },
          skip: parseInt(offset),
          take: Math.min(parseInt(limit), 500),
        });

        callback({
          success: true,
          data: messages.map(msg => ({
            id: msg.id,
            chatId: msg.chatId,
            direction: msg.direction,
            message: msg.message,
            status: msg.status,
            contactNumber: msg.contactNumber,
            contactName: msg.contactName,
            sentAt: msg.sentAt,
            createdAt: msg.createdAt,
          })),
          pagination: {
            count: messages.length,
            offset: parseInt(offset),
            limit: parseInt(limit),
          },
        });
      } catch (error) {
        logger.error('[Chats NS] chat:messages error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    /**
     * Get all messages history for an account
     * @event messages:history
     * @param {Object} data - { accountId, limit?, offset?, direction?, startDate?, endDate? }
     * @returns {Object} - { success, data: Message[], pagination }
     */
    socket.on('messages:history', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for messages:history');
        return;
      }

      const { accountId, limit = 100, offset = 0, direction, startDate, endDate } = data;

      if (!accountId) {
        return callback({ success: false, error: 'accountId is required' });
      }

      try {
        logger.info(`[Chats NS] messages:history for account: ${accountId}`);

        const where = { accountId };

        if (direction) {
          where.direction = direction; // 'INCOMING' or 'OUTGOING'
        }

        if (startDate || endDate) {
          where.sentAt = {};
          if (startDate) where.sentAt.gte = new Date(startDate);
          if (endDate) where.sentAt.lte = new Date(endDate);
        }

        const [messages, total] = await Promise.all([
          prisma.message.findMany({
            where,
            orderBy: { sentAt: 'desc' },
            skip: parseInt(offset),
            take: Math.min(parseInt(limit), 500),
          }),
          prisma.message.count({ where }),
        ]);

        callback({
          success: true,
          data: messages.map(msg => ({
            id: msg.id,
            chatId: msg.chatId,
            direction: msg.direction,
            message: msg.message,
            status: msg.status,
            contactNumber: msg.contactNumber,
            contactName: msg.contactName,
            to: msg.to,
            from: msg.from,
            sentAt: msg.sentAt,
            createdAt: msg.createdAt,
          })),
          pagination: {
            total,
            count: messages.length,
            offset: parseInt(offset),
            limit: parseInt(limit),
            hasMore: parseInt(offset) + messages.length < total,
          },
        });
      } catch (error) {
        logger.error('[Chats NS] messages:history error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // =============================================
    // SEND MESSAGES
    // =============================================

    /**
     * Send message to a specific chat (by chatId)
     * @event chat:send
     * @param {Object} data - { accountId, chatId, message }
     * @returns {Object} - { success, messageId, queued, queuePosition }
     */
    socket.on('chat:send', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chat:send');
        return;
      }

      const { accountId, chatId, message } = data;

      if (!accountId || !chatId || !message) {
        return callback({ success: false, error: 'accountId, chatId and message are required' });
      }

      try {
        logger.info(`[Chats NS] chat:send to ${chatId}`);

        const decodedChatId = decodeURIComponent(chatId);

        // Check client connection
        let clientInfo = clients.get(accountId);
        if (!clientInfo || clientInfo.status !== 'CONNECTED') {
          const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
          if (!account) {
            return callback({ success: false, error: 'Account not found' });
          }

          if (!clientInfo) {
            await initializeClient(accountId);
          } else if (clientInfo.status === 'DISCONNECTED') {
            await cleanupClient(accountId);
            await initializeClient(accountId);
          }

          await sleep(2000);
          clientInfo = clients.get(accountId);

          if (!clientInfo || clientInfo.status !== 'CONNECTED') {
            return callback({
              success: false,
              error: 'Account is connecting. Try again.',
              status: clientInfo?.status || 'DISCONNECTED',
            });
          }
        }

        // Normalize contact number (remove + and @suffix)
        const contactNumber = normalizePhone(decodedChatId.split('@')[0]);
        const queue = messageQueues.get(accountId) || [];
        const queueLength = queue.length;

        // Enqueue message with humanBehavior
        const messageId = enqueueMessage(accountId, contactNumber, message);

        logger.info(`[Chats NS] Message queued: ${messageId}, to: ${contactNumber}, position: ${queueLength + 1}`);

        if (queueLength === 0) {
          setTimeout(() => processMessageQueue(accountId), 100);
        }

        callback({
          success: true,
          queued: true,
          messageId,
          queuePosition: queueLength + 1,
          message: 'Message queued for delivery',
        });
      } catch (error) {
        logger.error('[Chats NS] chat:send error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    /**
     * Send single message to a phone number
     * @event message:send
     * @param {Object} data - { accountId, to, message }
     * @returns {Object} - { success, messageId, queued, queuePosition }
     */
    socket.on('message:send', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for message:send');
        return;
      }

      const { accountId, to, message } = data;

      if (!accountId || !to || !message) {
        return callback({ success: false, error: 'accountId, to and message are required' });
      }

      try {
        // Normalize phone number (remove + at start)
        const normalizedTo = normalizePhone(to);
        logger.info(`[Chats NS] message:send from ${accountId} to ${normalizedTo}`);

        // Check client connection
        let clientInfo = clients.get(accountId);
        if (!clientInfo || clientInfo.status !== 'CONNECTED') {
          const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
          if (!account) {
            return callback({ success: false, error: 'Account not found' });
          }

          if (!clientInfo) {
            await initializeClient(accountId);
          } else if (clientInfo.status === 'DISCONNECTED') {
            await cleanupClient(accountId);
            await initializeClient(accountId);
          }

          await sleep(2000);
          clientInfo = clients.get(accountId);

          if (!clientInfo || clientInfo.status !== 'CONNECTED') {
            return callback({
              success: false,
              error: 'Account is connecting. Try again.',
              status: clientInfo?.status || 'DISCONNECTED',
            });
          }
        }

        const queue = messageQueues.get(accountId) || [];
        const queueLength = queue.length;

        // Enqueue message with humanBehavior (always uses queue)
        const messageId = enqueueMessage(accountId, normalizedTo, message);

        logger.info(`[Chats NS] Message queued: ${messageId}, to: ${normalizedTo}, position: ${queueLength + 1}`);

        if (queueLength === 0) {
          setTimeout(() => processMessageQueue(accountId), 100);
        }

        callback({
          success: true,
          queued: true,
          messageId,
          queuePosition: queueLength + 1,
          message: 'Message queued for delivery',
        });
      } catch (error) {
        logger.error('[Chats NS] message:send error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // =============================================
    // QUEUE STATUS
    // =============================================

    /**
     * Get message queue status for an account
     * @event queue:status
     * @param {Object} data - { accountId }
     * @returns {Object} - { success, data: QueueStatus }
     */
    socket.on('queue:status', async (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for queue:status');
        return;
      }

      const { accountId } = data;

      if (!accountId) {
        return callback({ success: false, error: 'accountId is required' });
      }

      try {
        const queue = messageQueues.get(accountId) || [];
        const clientInfo = clients.get(accountId);

        callback({
          success: true,
          data: {
            accountId,
            queueLength: queue.length,
            clientStatus: clientInfo?.status || 'DISCONNECTED',
            messages: queue.slice(0, 20).map((msg, index) => ({
              position: index + 1,
              to: msg.to,
              messagePreview: msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : ''),
              retries: msg.retries,
              createdAt: msg.createdAt,
            })),
          },
        });
      } catch (error) {
        logger.error('[Chats NS] queue:status error:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // =============================================
    // CONNECTION EVENTS
    // =============================================

    socket.on('disconnect', () => {
      logger.info(`[Chats NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error('[Chats NS] Socket error:', error);
    });
  });

  return chatsNS;
};
