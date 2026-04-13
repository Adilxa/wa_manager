/**
 * WebSocket Namespace: /chats
 * Handles all chat and messaging operations
 */

module.exports = function(io, dependencies) {
  const { clients, prisma, logger, messageQueues, enqueueMessage, processMessageQueue, initializeClient, cleanupClient } = dependencies;
  const chatsNS = io.of('/chats');

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chatsNS.on('connection', (socket) => {
    logger.info(`[Chats NS] Connected: ${socket.id}`);

    // Subscribe to chat updates for an account
    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.debug(`[Chats NS] Socket ${socket.id} joined account:${accountId}`);
    });

    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.debug(`[Chats NS] Socket ${socket.id} left account:${accountId}`);
    });

    // Get all chats for an account
    socket.on('chats:list', async (...args) => {
      logger.info('[Chats NS] Received chats:list, args:', args.length, 'types:', args.map(a => typeof a));

      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chats:list');
        return;
      }

      const { accountId, page = 1, limit = 50, phone } = data;

      try {
        logger.info(`[Chats NS] Fetching chats for account: ${accountId}, page: ${page}, limit: ${limit}`);
        const pageNum = parseInt(page);
        const limitNum = Math.min(parseInt(limit), 100);
        const skip = (pageNum - 1) * limitNum;

        const where = { accountId };

        if (phone) {
          where.OR = [
            { to: { contains: phone } },
            { from: { contains: phone } },
            { contactNumber: { contains: phone } },
          ];
        }

        const messages = await prisma.message.findMany({
          where,
          orderBy: { sentAt: 'desc' },
          take: 5000,
        });

        const chatsMap = new Map();

        messages.forEach(msg => {
          const key = msg.contactNumber || msg.to || msg.from || msg.chatId;
          if (!key) return;

          if (!chatsMap.has(key)) {
            chatsMap.set(key, {
              chatId: msg.chatId,
              contactNumber: msg.contactNumber || msg.to || msg.from,
              contactName: msg.contactName,
              messages: [],
              unreadCount: 0,
              lastMessageTime: msg.sentAt,
            });
          }

          const chat = chatsMap.get(key);
          if (chat.messages.length < 50) {
            chat.messages.push(msg);
          }

          if (new Date(msg.sentAt) > new Date(chat.lastMessageTime)) {
            chat.lastMessageTime = msg.sentAt;
          }
        });

        let chatsArray = Array.from(chatsMap.values());
        chatsArray.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        const total = chatsArray.length;
        const paginatedChats = chatsArray.slice(skip, skip + limitNum);
        const totalPages = Math.ceil(total / limitNum);

        logger.info(`[Chats NS] Found ${total} chats, returning ${paginatedChats.length} for page ${pageNum}`);

        const response = {
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
        };

        callback(response);
      } catch (error) {
        logger.error('[Chats NS] Failed to get chats:', error.message, error.stack);
        if (callback) {
          callback({ success: false, error: error.message });
        }
      }
    });

    // Get messages for a specific chat
    socket.on('chat:messages', async (...args) => {
      logger.info('[Chats NS] Received chat:messages, args:', args.length, 'types:', args.map(a => typeof a));

      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chat:messages');
        return;
      }

      const { accountId, chatId } = data;

      try {
        logger.info(`[Chats NS] Fetching messages for chat: ${chatId}, account: ${accountId}`);

        const decodedChatId = decodeURIComponent(chatId);

        const messages = await prisma.message.findMany({
          where: { accountId, chatId: decodedChatId },
          orderBy: { sentAt: 'asc' },
          take: 500,
        });

        logger.info(`[Chats NS] Found ${messages.length} messages for chat ${chatId}`);

        callback({ success: true, data: messages });
      } catch (error) {
        logger.error('[Chats NS] Failed to get chat messages:', error.message, error.stack);
        if (callback) {
          callback({ success: false, error: error.message });
        }
      }
    });

    // Send message to a chat
    socket.on('chat:send', async (...args) => {
      logger.info('[Chats NS] Received chat:send, args:', args.length, 'types:', args.map(a => typeof a));

      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for chat:send');
        return;
      }

      const { accountId, chatId, message } = data;

      try {
        logger.info(`[Chats NS] Sending to chat: ${chatId}, account: ${accountId}`);

        const decodedChatId = decodeURIComponent(chatId);

        if (!message) {
          logger.error('[Chats NS] Message is required');
          return callback({ success: false, error: 'Message is required' });
        }

        let clientInfo = clients.get(accountId);

        if (!clientInfo || clientInfo.status !== 'CONNECTED') {
          try {
            const account = await prisma.whatsAppAccount.findUnique({
              where: { id: accountId },
            });

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
          } catch (connectError) {
            return callback({
              success: false,
              error: 'Failed to connect account',
              details: connectError.message,
            });
          }
        }

        const contactNumber = decodedChatId.split('@')[0];
        const queue = messageQueues.get(accountId) || [];
        const queueLength = queue.length;

        const messageId = enqueueMessage(accountId, contactNumber, message);

        logger.info(`[Chats NS] Chat message queued: ${messageId}, contact: ${contactNumber}, queue length: ${queueLength + 1}`);

        if (queueLength === 0) {
          setTimeout(() => processMessageQueue(accountId), 100);
        }

        const response = {
          success: true,
          queued: true,
          messageId,
          queuePosition: queueLength + 1,
          queueLength: queueLength + 1,
          message: 'Message queued for delivery',
        };

        logger.info('[Chats NS] Sending chat:send response:', response);
        callback(response);
      } catch (error) {
        logger.error('[Chats NS] Failed to queue chat message:', error.message, error.stack);
        if (callback) {
          callback({ success: false, error: error.message });
        }
      }
    });

    // Send single message (for quick sends)
    socket.on('message:send', async (...args) => {
      logger.info('[Chats NS] Received message:send, args:', args.length, 'types:', args.map(a => typeof a));

      // The last argument should be the callback (if acknowledgement is requested)
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for message:send');
        return;
      }

      const { accountId, to, message } = data;

      try {
        if (!accountId || !to || !message) {
          logger.error('[Chats NS] Missing required fields:', { accountId, to, hasMessage: !!message });
          return callback({ success: false, error: 'Missing required fields' });
        }

        logger.info(`[Chats NS] Sending message from ${accountId} to ${to}, length: ${message.length}`);

        let clientInfo = clients.get(accountId);

        if (!clientInfo || clientInfo.status !== 'CONNECTED') {
          try {
            const account = await prisma.whatsAppAccount.findUnique({
              where: { id: accountId },
            });

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
                error: 'Account is connecting. Try again in a few seconds.',
                status: clientInfo?.status || 'DISCONNECTED',
              });
            }
          } catch (connectError) {
            return callback({
              success: false,
              error: 'Failed to connect account',
              details: connectError.message,
            });
          }
        }

        const messageId = enqueueMessage(accountId, to, message);
        const queue = messageQueues.get(accountId) || [];

        logger.info(`[Chats NS] Message queued: ${messageId}, queue length: ${queue.length}`);

        if (queue.length === 1) {
          setTimeout(() => processMessageQueue(accountId), 100);
        }

        const response = {
          success: true,
          queued: true,
          messageId,
          queuePosition: queue.length,
          message: 'Message queued for delivery',
        };

        logger.info('[Chats NS] Sending response:', response);
        callback(response);
      } catch (error) {
        logger.error('[Chats NS] Failed to queue message:', error.message, error.stack);
        if (callback) {
          callback({ success: false, error: error.message });
        }
      }
    });

    // Get queue status
    socket.on('queue:status', async (...args) => {
      logger.info('[Chats NS] Received queue:status, args:', args.length, 'types:', args.map(a => typeof a));

      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const data = args[0] || {};

      if (!callback) {
        logger.warn('[Chats NS] No callback provided for queue:status');
        return;
      }

      const { accountId } = data;

      try {
        const queue = messageQueues.get(accountId) || [];
        const clientInfo = clients.get(accountId);

        logger.info(`[Chats NS] Queue status for ${accountId}: ${queue.length} messages, client: ${clientInfo?.status || 'DISCONNECTED'}`);

        callback({
          success: true,
          data: {
            accountId,
            queueLength: queue.length,
            messages: queue.slice(0, 20).map((msg, index) => ({
              position: index + 1,
              to: msg.to,
              message: msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : ''),
              retries: msg.retries,
            })),
            status: {
              clientStatus: clientInfo?.status || 'DISCONNECTED',
            },
          },
        });
      } catch (error) {
        logger.error('[Chats NS] Failed to get queue status:', error.message, error.stack);
        if (callback) {
          callback({ success: false, error: error.message });
        }
      }
    });

    socket.on('disconnect', () => {
      logger.info(`[Chats NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error('[Chats NS] Socket error:', error);
    });
  });

  return chatsNS;
};
