/**
 * WebSocket Namespace: /accounts
 * Handles all account-related operations
 */

const path = require('path');
const fs = require('fs');

module.exports = function(io, dependencies) {
  const { clients, prisma, getPrisma, isPrismaConnected, logger, connectingAccounts, initializeClient, cleanupClient, reconnectAttempts } = dependencies;
  const accountsNS = io.of('/accounts');
  const DB_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS || '15000', 10);

  const SESSIONS_DIR = path.join(process.cwd(), '.baileys_auth');

  function withTimeout(promise, label) {
    promise.catch(() => {});
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS)
      ),
    ]);
  }

  function requirePrisma(callback) {
    const db = getPrisma ? getPrisma() : prisma;

    if (!db || (isPrismaConnected && !isPrismaConnected())) {
      callback({ success: false, error: 'Database is not connected' });
      return null;
    }

    return db;
  }

  function getPublicClientStatus(account, clientStatus) {
    if (clientStatus?.status) {
      return clientStatus.status;
    }

    if (process.env.ENABLE_WHATSAPP_CLIENTS !== 'true' && account.status === 'CONNECTED') {
      return 'DISCONNECTED';
    }

    return account.status;
  }

  function withPublicClientStatus(account) {
    const clientStatus = clients.get(account.id);

    return {
      ...account,
      clientStatus: getPublicClientStatus(account, clientStatus),
      hasActiveClient: !!clientStatus,
      lastHeartbeat: clientStatus?.lastHeartbeat || null,
      latency: clientStatus?.latency || null,
    };
  }

  accountsNS.on('connection', (socket) => {
    logger.info(`[Accounts NS] Connected: ${socket.id}`);

    socket.onAny((event, ...args) => {
      logger.info(`[Accounts NS] Event ${event} from ${socket.id}, args=${args.map((arg) => typeof arg).join(',')}`);
    });

    // Subscribe to account updates
    socket.on('join', (accountId) => {
      socket.join(`account:${accountId}`);
      logger.debug(`[Accounts NS] Socket ${socket.id} joined account:${accountId}`);
    });

    socket.on('leave', (accountId) => {
      socket.leave(`account:${accountId}`);
      logger.debug(`[Accounts NS] Socket ${socket.id} left account:${accountId}`);
    });

    // Get all accounts
    socket.on('accounts:list', async (...args) => {
      const callback = args.find((arg) => typeof arg === 'function');

      if (!callback) {
        logger.warn('[Accounts NS] accounts:list called without callback');
        return;
      }

      try {
        const db = requirePrisma(callback);
        if (!db) return;

        logger.info('[Accounts NS] accounts:list loading accounts');
        const accounts = await withTimeout(
          db.whatsAppAccount.findMany({
            orderBy: { createdAt: 'desc' },
          }),
          'accounts:list'
        );

        const accountsWithClientStatus = accounts.map(withPublicClientStatus);

        logger.info(`[Accounts NS] accounts:list returned ${accountsWithClientStatus.length} account(s)`);
        callback({ success: true, data: accountsWithClientStatus });
      } catch (error) {
        logger.error('[Accounts NS] Failed to list accounts:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Get account by ID
    socket.on('account:get', async ({ accountId }, callback) => {
      try {
        const db = requirePrisma(callback);
        if (!db) return;

        const account = await db.whatsAppAccount.findUnique({
          where: { id: accountId },
        });

        if (!account) {
          return callback({ success: false, error: 'Account not found' });
        }

        callback({
          success: true,
          data: withPublicClientStatus(account)
        });
      } catch (error) {
        logger.error('[Accounts NS] Failed to get account:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Create new account
    socket.on('account:create', async ({ name, useLimits = true }, callback) => {
      try {
        const db = requirePrisma(callback);
        if (!db) return;

        const account = await db.whatsAppAccount.create({
          data: { name, useLimits },
        });
        logger.info(`[Accounts NS] Created account: ${account.id} (${name})`);

        // Broadcast to all clients
        accountsNS.emit('account:created', account);

        callback({ success: true, data: account });
      } catch (error) {
        logger.error('[Accounts NS] Failed to create account:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Update account
    socket.on('account:update', async ({ accountId, name, useLimits }, callback) => {
      try {
        const db = requirePrisma(callback);
        if (!db) return;

        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (useLimits !== undefined) updateData.useLimits = useLimits;

        const account = await db.whatsAppAccount.update({
          where: { id: accountId },
          data: updateData,
        });

        // Broadcast update
        accountsNS.to(`account:${accountId}`).emit('account:updated', account);

        callback({ success: true, data: account });
      } catch (error) {
        logger.error('[Accounts NS] Failed to update account:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Connect account (start WhatsApp session)
    socket.on('account:connect', async ({ accountId }, callback) => {
      try {
        if (process.env.ENABLE_WHATSAPP_CLIENTS !== 'true') {
          return callback({ success: false, error: 'WhatsApp client initialization is disabled' });
        }

        if (connectingAccounts.has(accountId)) {
          return callback({ success: false, error: 'Client is already being initialized' });
        }

        const existing = clients.get(accountId);
        if (existing && existing.status === 'CONNECTED') {
          return callback({ success: false, error: 'Client already connected' });
        }

        if (existing && (existing.status === 'AUTHENTICATING' || existing.status === 'CONNECTING')) {
          const stuckTime = Date.now() - (existing.lastActivity || 0);
          if (stuckTime > 120000) {
            await cleanupClient(accountId);
          }
        }

        await initializeClient(accountId);
        callback({ success: true, message: 'Client initialization started' });
      } catch (error) {
        logger.error(`[Accounts NS] Failed to connect ${accountId}:`, error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Disconnect account
    socket.on('account:disconnect', async ({ accountId }, callback) => {
      try {
        const clientInfo = clients.get(accountId);

        if (!clientInfo) {
          return callback({ success: false, error: 'Client not found' });
        }

        reconnectAttempts.delete(accountId);
        connectingAccounts.delete(accountId);

        try {
          await clientInfo.sock.logout();
        } catch (e) {
          // Ignore logout errors
        }

        await cleanupClient(accountId);
        const db = requirePrisma(callback);
        if (!db) return;

        await db.whatsAppAccount.update({
          where: { id: accountId },
          data: { status: 'DISCONNECTED' },
        });

        logger.info(`[Accounts NS] Disconnected: ${accountId}`);
        callback({ success: true });
      } catch (error) {
        logger.error('[Accounts NS] Failed to disconnect:', error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Reset session
    socket.on('account:reset', async ({ accountId }, callback) => {
      try {
        reconnectAttempts.delete(accountId);
        connectingAccounts.delete(accountId);

        const clientInfo = clients.get(accountId);
        if (clientInfo) {
          try {
            await clientInfo.sock.end();
          } catch (e) {}
          await cleanupClient(accountId);
        }

        const sessionPath = path.join(SESSIONS_DIR, `session_${accountId}`);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        const db = requirePrisma(callback);
        if (!db) return;

        await db.whatsAppAccount.update({
          where: { id: accountId },
          data: { status: 'DISCONNECTED' },
        });

        callback({ success: true, message: 'Session reset successfully' });
      } catch (error) {
        logger.error(`[Accounts NS] Failed to reset session ${accountId}:`, error.message);
        callback({ success: false, error: error.message });
      }
    });

    // Delete account
    socket.on('account:delete', async ({ accountId }, callback) => {
      try {
        const db = requirePrisma(callback);
        if (!db) return;

        const account = await db.whatsAppAccount.findUnique({
          where: { id: accountId },
        });

        if (!account) {
          return callback({ success: false, error: 'Account not found' });
        }

        reconnectAttempts.delete(accountId);

        const clientInfo = clients.get(accountId);
        if (clientInfo) {
          try {
            await clientInfo.sock.logout();
          } catch (e) {}
          await cleanupClient(accountId);
        }

        const sessionPath = path.join(SESSIONS_DIR, `session_${accountId}`);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        await db.whatsAppAccount.delete({
          where: { id: accountId },
        });

        // Broadcast deletion
        accountsNS.emit('account:deleted', { accountId });

        logger.info(`[Accounts NS] Deleted account: ${accountId}`);
        callback({ success: true });
      } catch (error) {
        logger.error(`[Accounts NS] Failed to delete account ${accountId}:`, error.message);
        callback({ success: false, error: error.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info(`[Accounts NS] Disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error('[Accounts NS] Socket error:', error);
    });
  });

  return accountsNS;
};
