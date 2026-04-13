import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';
const USE_WEBSOCKET = process.env.NEXT_PUBLIC_USE_WEBSOCKET === 'true';

class SocketManager {
  private sockets: Map<string, Socket> = new Map();

  isEnabled(): boolean {
    return USE_WEBSOCKET;
  }

  getSocket(namespace: string): Socket {
    if (!this.isEnabled()) {
      throw new Error('WebSocket is disabled');
    }

    if (!this.sockets.has(namespace)) {
      const socket = io(`${API_URL}${namespace}`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity
      });

      socket.on('connect', () => {
        console.log(`[WS] Connected: ${namespace}`);
      });

      socket.on('disconnect', (reason) => {
        console.log(`[WS] Disconnected: ${namespace} - ${reason}`);
      });

      socket.on('error', (error) => {
        console.error(`[WS] Error on ${namespace}:`, error);
      });

      this.sockets.set(namespace, socket);
    }

    return this.sockets.get(namespace)!;
  }

  disconnectAll() {
    this.sockets.forEach(socket => socket.disconnect());
    this.sockets.clear();
  }
}

export const socketManager = new SocketManager();
