/**
 * React Hooks for WebSocket API
 *
 * Provides real-time data and actions through WebSocket
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { accountsSocket, chatsSocket, qrSocket } from '../socket';

// ===== ACCOUNTS HOOKS =====

export function useAccounts() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const response = await accountsSocket.list();
      if (response.success && response.data) {
        setAccounts(response.data);
        setError(null);
      } else {
        setError(response.error || 'Failed to load accounts');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();

    // Subscribe to real-time updates
    accountsSocket.onCreated((account) => {
      setAccounts((prev) => [...prev, account]);
    });

    accountsSocket.onUpdated((account) => {
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, ...account } : a))
      );
    });

    accountsSocket.onDeleted(({ accountId }) => {
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
    });

    accountsSocket.onStatusUpdate((data) => {
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === data.accountId
            ? { ...a, status: data.status, phoneNumber: data.phoneNumber }
            : a
        )
      );
    });
  }, [loadAccounts]);

  const createAccount = useCallback(async (name: string, useLimits = true) => {
    const response = await accountsSocket.create(name, useLimits);
    if (response.success) {
      return response.data;
    }
    throw new Error(response.error || 'Failed to create account');
  }, []);

  const connectAccount = useCallback(async (accountId: string) => {
    const response = await accountsSocket.connect(accountId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to connect');
    }
  }, []);

  const disconnectAccount = useCallback(async (accountId: string) => {
    const response = await accountsSocket.disconnect(accountId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to disconnect');
    }
  }, []);

  const resetAccount = useCallback(async (accountId: string) => {
    const response = await accountsSocket.reset(accountId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to reset');
    }
  }, []);

  const deleteAccount = useCallback(async (accountId: string) => {
    const response = await accountsSocket.delete(accountId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to delete');
    }
  }, []);

  const updateAccount = useCallback(
    async (accountId: string, data: { name?: string; useLimits?: boolean }) => {
      const response = await accountsSocket.update(accountId, data);
      if (!response.success) {
        throw new Error(response.error || 'Failed to update');
      }
      return response.data;
    },
    []
  );

  return {
    accounts,
    loading,
    error,
    refresh: loadAccounts,
    createAccount,
    connectAccount,
    disconnectAccount,
    resetAccount,
    deleteAccount,
    updateAccount,
  };
}

export function useAccountStatus(accountId: string | null) {
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    if (!accountId) {
      setStatus(null);
      return;
    }

    // Join room for this account
    accountsSocket.join(accountId);

    // Listen for status updates
    const handleStatusUpdate = (data: any) => {
      if (data.accountId === accountId) {
        setStatus(data);
      }
    };

    accountsSocket.onStatusUpdate(handleStatusUpdate);

    return () => {
      accountsSocket.leave(accountId);
    };
  }, [accountId]);

  return status;
}

// ===== CHATS HOOKS =====

export function useChats(accountId: string | null) {
  const [chats, setChats] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChats = useCallback(
    async (options?: { page?: number; limit?: number; phone?: string }) => {
      if (!accountId) return;

      setLoading(true);
      try {
        const response = await chatsSocket.list(accountId, options);
        if (response.success && response.data) {
          setChats(response.data);
          setError(null);
        } else {
          setError(response.error || 'Failed to load chats');
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load chats');
      } finally {
        setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    if (!accountId) {
      setChats([]);
      return;
    }

    loadChats();

    // Join room for this account
    chatsSocket.join(accountId);

    // Listen for new messages
    chatsSocket.onNewMessage((data) => {
      if (data.accountId === accountId) {
        // Reload chats when new message arrives
        loadChats();
      }
    });

    return () => {
      chatsSocket.leave(accountId);
    };
  }, [accountId, loadChats]);

  const sendMessage = useCallback(
    async (to: string, message: string) => {
      if (!accountId) throw new Error('No account selected');

      const response = await chatsSocket.send(accountId, to, message);
      if (!response.success) {
        throw new Error(response.error || 'Failed to send message');
      }
      return response;
    },
    [accountId]
  );

  return {
    chats,
    loading,
    error,
    refresh: loadChats,
    sendMessage,
  };
}

export function useChatMessages(accountId: string | null, chatId: string | null) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadMessages = useCallback(async () => {
    if (!accountId || !chatId) return;

    setLoading(true);
    try {
      const response = await chatsSocket.getMessages(accountId, chatId);
      if (response.success && response.data) {
        setMessages(response.data);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoading(false);
    }
  }, [accountId, chatId]);

  useEffect(() => {
    if (!accountId || !chatId) {
      setMessages([]);
      return;
    }

    loadMessages();

    // Join room and listen for new messages
    chatsSocket.join(accountId);

    chatsSocket.onNewMessage((data) => {
      if (data.accountId === accountId && data.chatId === chatId) {
        setMessages((prev) => [...prev, data.message]);
      }
    });

    return () => {
      chatsSocket.leave(accountId);
    };
  }, [accountId, chatId, loadMessages]);

  const sendMessage = useCallback(
    async (message: string) => {
      if (!accountId || !chatId) throw new Error('Invalid chat');

      const response = await chatsSocket.sendToChat(accountId, chatId, message);
      if (!response.success) {
        throw new Error(response.error || 'Failed to send message');
      }
      return response;
    },
    [accountId, chatId]
  );

  return {
    messages,
    loading,
    refresh: loadMessages,
    sendMessage,
  };
}

// ===== QR CODE HOOK =====

export function useQRCode(accountId: string | null) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<number>(0);

  useEffect(() => {
    if (!accountId) {
      setQrCode(null);
      setExpiresIn(0);
      return;
    }

    // Join QR room
    qrSocket.join(accountId);

    // Listen for QR generation
    qrSocket.onGenerated((data) => {
      if (data.accountId === accountId) {
        setQrCode(data.qrCode);
        setExpiresIn(data.expiresIn);

        // Start countdown
        const interval = setInterval(() => {
          setExpiresIn((prev) => {
            if (prev <= 1) {
              clearInterval(interval);
              setQrCode(null);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);

        return () => clearInterval(interval);
      }
    });

    return () => {
      qrSocket.leave(accountId);
    };
  }, [accountId]);

  return {
    qrCode,
    expiresIn,
  };
}

// ===== QUEUE STATUS HOOK =====

export function useQueueStatus(accountId: string | null) {
  const [queueStatus, setQueueStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const loadQueueStatus = useCallback(async () => {
    if (!accountId) return;

    setLoading(true);
    try {
      const response = await chatsSocket.getQueueStatus(accountId);
      if (response.success && response.data) {
        setQueueStatus(response.data);
      }
    } catch (err) {
      console.error('Failed to load queue status:', err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId) {
      setQueueStatus(null);
      return;
    }

    loadQueueStatus();

    // Refresh every 5 seconds
    const interval = setInterval(loadQueueStatus, 5000);

    return () => clearInterval(interval);
  }, [accountId, loadQueueStatus]);

  return {
    queueStatus,
    loading,
    refresh: loadQueueStatus,
  };
}
