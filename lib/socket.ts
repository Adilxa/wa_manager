/**
 * WebSocket Client for WhatsApp Manager
 *
 * Provides real-time communication with the server through Socket.IO
 * Supports multiple namespaces: /accounts, /chats, /qr
 */

import { io, Socket } from 'socket.io-client';

// In production, API is proxied through the same domain
// In development, API runs on port 5001
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

type SocketCallback<T = any> = (response: { success: boolean; data?: T; error?: string }) => void;

class SocketManager {
  private sockets: Map<string, Socket> = new Map();
  private listeners: Map<string, Map<string, Function[]>> = new Map();

  /**
   * Get or create a socket for a namespace
   */
  getSocket(namespace: string): Socket {
    if (!this.sockets.has(namespace)) {
      // In production, use the same domain with /socket.io path
      // In development, connect directly to API server
      const socketUrl = IS_PRODUCTION ? '' : API_URL;
      const socketOptions: any = {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
        timeout: 10000,
        autoConnect: true,
      };

      console.log(`[WS] Creating socket for ${namespace}, URL: ${socketUrl || 'same-origin'}, path: /socket.io`);

      const socket = io(`${socketUrl}${namespace}`, socketOptions);

      socket.on('connect', () => {
        console.log(`[WS] Connected: ${namespace}`);
      });

      socket.on('disconnect', (reason) => {
        console.log(`[WS] Disconnected: ${namespace} - ${reason}`);
      });

      socket.on('error', (error) => {
        console.error(`[WS] Error on ${namespace}:`, error);
      });

      socket.on('connect_error', (error) => {
        console.error(`[WS] Connection error on ${namespace}:`, error.message);
      });

      this.sockets.set(namespace, socket);
      this.listeners.set(namespace, new Map());
    }

    return this.sockets.get(namespace)!;
  }

  /**
   * Wait for socket to connect
   */
  private waitForConnection(namespace: string, timeout = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.getSocket(namespace);

      if (socket.connected) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout for ${namespace}`));
      }, timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Subscribe to events on a namespace
   */
  on(namespace: string, event: string, callback: Function) {
    const socket = this.getSocket(namespace);
    socket.on(event, callback as any);

    // Track listeners for cleanup
    const nsListeners = this.listeners.get(namespace)!;
    if (!nsListeners.has(event)) {
      nsListeners.set(event, []);
    }
    nsListeners.get(event)!.push(callback);
  }

  /**
   * Unsubscribe from an event
   */
  off(namespace: string, event: string, callback?: Function) {
    const socket = this.sockets.get(namespace);
    if (!socket) return;

    if (callback) {
      socket.off(event, callback as any);
    } else {
      socket.off(event);
    }

    // Clean up listener tracking
    const nsListeners = this.listeners.get(namespace);
    if (nsListeners) {
      nsListeners.delete(event);
    }
  }

  /**
   * Emit an event and wait for callback
   */
  async emit<T = any>(namespace: string, event: string, data?: any): Promise<{ success: boolean; data?: T; error?: string }> {
    try {
      // Wait for connection first
      await this.waitForConnection(namespace);

      return new Promise((resolve) => {
        const socket = this.getSocket(namespace);

        // Set timeout for response
        const timeout = setTimeout(() => {
          console.error(`[WS] Timeout waiting for ${event} on ${namespace}`);
          resolve({ success: false, error: 'Request timeout' });
        }, 30000); // 30 second timeout

        console.log(`[WS] Emitting ${event} on ${namespace}`, data);

        // Socket.IO requires callback as last argument
        // If data is undefined, don't pass it
        const callback = (response: any) => {
          clearTimeout(timeout);
          console.log(`[WS] Response for ${event}:`, response);

          if (!response) {
            resolve({ success: false, error: 'No response from server' });
          } else {
            resolve(response);
          }
        };

        if (data !== undefined) {
          socket.emit(event, data, callback);
        } else {
          socket.emit(event, callback);
        }
      });
    } catch (error: any) {
      console.error(`[WS] Failed to emit ${event}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Disconnect a specific namespace
   */
  disconnect(namespace: string) {
    const socket = this.sockets.get(namespace);
    if (socket) {
      socket.disconnect();
      this.sockets.delete(namespace);
      this.listeners.delete(namespace);
    }
  }

  /**
   * Disconnect all namespaces
   */
  disconnectAll() {
    this.sockets.forEach(socket => socket.disconnect());
    this.sockets.clear();
    this.listeners.clear();
  }
}

// Singleton instance
export const socketManager = new SocketManager();

// === ACCOUNTS API ===

export const accountsSocket = {
  /**
   * Join account updates room
   */
  join(accountId: string) {
    socketManager.getSocket('/accounts').emit('join', accountId);
  },

  /**
   * Leave account updates room
   */
  leave(accountId: string) {
    socketManager.getSocket('/accounts').emit('leave', accountId);
  },

  /**
   * Get all accounts
   */
  list(): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return socketManager.emit('/accounts', 'accounts:list');
  },

  /**
   * Get account by ID
   */
  get(accountId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return socketManager.emit('/accounts', 'account:get', { accountId });
  },

  /**
   * Create new account
   */
  create(name: string, useLimits = true): Promise<{ success: boolean; data?: any; error?: string }> {
    return socketManager.emit('/accounts', 'account:create', { name, useLimits });
  },

  /**
   * Update account
   */
  update(accountId: string, data: { name?: string; useLimits?: boolean }): Promise<{ success: boolean; data?: any; error?: string }> {
    return socketManager.emit('/accounts', 'account:update', { accountId, ...data });
  },

  /**
   * Connect account (start WhatsApp session)
   */
  connect(accountId: string): Promise<{ success: boolean; error?: string }> {
    return socketManager.emit('/accounts', 'account:connect', { accountId });
  },

  /**
   * Disconnect account
   */
  disconnect(accountId: string): Promise<{ success: boolean; error?: string }> {
    return socketManager.emit('/accounts', 'account:disconnect', { accountId });
  },

  /**
   * Reset session
   */
  reset(accountId: string): Promise<{ success: boolean; error?: string }> {
    return socketManager.emit('/accounts', 'account:reset', { accountId });
  },

  /**
   * Delete account
   */
  delete(accountId: string): Promise<{ success: boolean; error?: string }> {
    return socketManager.emit('/accounts', 'account:delete', { accountId });
  },

  /**
   * Subscribe to account status updates
   */
  onStatusUpdate(callback: (data: any) => void) {
    socketManager.on('/accounts', 'account:status', callback);
  },

  /**
   * Subscribe to account created events
   */
  onCreated(callback: (data: any) => void) {
    socketManager.on('/accounts', 'account:created', callback);
  },

  /**
   * Subscribe to account updated events
   */
  onUpdated(callback: (data: any) => void) {
    socketManager.on('/accounts', 'account:updated', callback);
  },

  /**
   * Subscribe to account deleted events
   */
  onDeleted(callback: (data: any) => void) {
    socketManager.on('/accounts', 'account:deleted', callback);
  },
};

// === CHATS API ===

export const chatsSocket = {
  /**
   * Join chat updates for an account
   */
  join(accountId: string) {
    socketManager.getSocket('/chats').emit('join', accountId);
  },

  /**
   * Leave chat updates
   */
  leave(accountId: string) {
    socketManager.getSocket('/chats').emit('leave', accountId);
  },

  /**
   * Get all chats for an account
   */
  list(accountId: string, options?: { page?: number; limit?: number; phone?: string }): Promise<{ success: boolean; data?: any[]; pagination?: any; error?: string }> {
    return socketManager.emit('/chats', 'chats:list', { accountId, ...options });
  },

  /**
   * Get messages for a chat
   */
  getMessages(accountId: string, chatId: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    return socketManager.emit('/chats', 'chat:messages', { accountId, chatId });
  },

  /**
   * Send message to chat
   */
  sendToChat(accountId: string, chatId: string, message: string): Promise<{ success: boolean; messageId?: string; queued?: boolean; queuePosition?: number; error?: string }> {
    return socketManager.emit('/chats', 'chat:send', { accountId, chatId, message });
  },

  /**
   * Send single message
   */
  send(accountId: string, to: string, message: string): Promise<{ success: boolean; messageId?: string; queued?: boolean; queuePosition?: number; error?: string }> {
    return socketManager.emit('/chats', 'message:send', { accountId, to, message });
  },

  /**
   * Get queue status
   */
  getQueueStatus(accountId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return socketManager.emit('/chats', 'queue:status', { accountId });
  },

  /**
   * Subscribe to new messages
   */
  onNewMessage(callback: (data: any) => void) {
    socketManager.on('/chats', 'chat:message:new', callback);
  },
};

// === QR API ===

export const qrSocket = {
  /**
   * Join QR updates for an account
   */
  join(accountId: string) {
    socketManager.getSocket('/qr').emit('join', accountId);
  },

  /**
   * Leave QR updates
   */
  leave(accountId: string) {
    socketManager.getSocket('/qr').emit('leave', accountId);
  },

  /**
   * Subscribe to QR code generation
   */
  onGenerated(callback: (data: { accountId: string; qrCode: string; expiresIn: number }) => void) {
    socketManager.on('/qr', 'qr:generated', callback);
  },
};

// Export singleton
export default socketManager;
