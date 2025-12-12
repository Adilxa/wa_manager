'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Send,
  Search,
  ArrowLeft,
  MoreVertical,
  Phone,
  Video,
  Paperclip,
  Smile,
  Check,
  CheckCheck,
  MessageCircle,
  User,
  Loader2,
} from 'lucide-react';

interface Account {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
}

interface Chat {
  chatId: string;
  contactNumber: string;
  contactName: string;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  direction: string;
}

interface Message {
  id: string;
  direction: string;
  message: string;
  sentAt: string;
  status: string;
  contactName?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function ChatPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Refs для предотвращения множественных запросов
  const chatsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const messagesIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingChatsRef = useRef(false);
  const isLoadingMessagesRef = useRef(false);

  // Проверка авторизации
  useEffect(() => {
    const isAuth = localStorage.getItem('wa_manager_auth');
    if (!isAuth) {
      router.push('/login');
    }
  }, [router]);

  // Загрузка аккаунтов
  useEffect(() => {
    loadAccounts();
  }, []);

  // Загрузка чатов при выборе аккаунта
  useEffect(() => {
    // Очищаем предыдущий интервал
    if (chatsIntervalRef.current) {
      clearInterval(chatsIntervalRef.current);
      chatsIntervalRef.current = null;
    }

    if (!selectedAccount) return;

    const accountId = selectedAccount.id;

    // Загружаем чаты сразу
    loadChats(accountId);

    // Создаем интервал для обновления
    const interval = setInterval(() => {
      loadChats(accountId);
    }, 5000);

    chatsIntervalRef.current = interval;

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [selectedAccount?.id]);

  // Загрузка сообщений при выборе чата
  useEffect(() => {
    // Очищаем предыдущий интервал
    if (messagesIntervalRef.current) {
      clearInterval(messagesIntervalRef.current);
      messagesIntervalRef.current = null;
    }

    if (!selectedChat || !selectedAccount) return;

    const accountId = selectedAccount.id;
    const chatId = selectedChat.chatId;

    // Загружаем сообщения сразу
    loadMessages(accountId, chatId);

    // Создаем интервал для обновления
    const interval = setInterval(() => {
      loadMessages(accountId, chatId);
    }, 3000);

    messagesIntervalRef.current = interval;

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [selectedChat?.chatId, selectedAccount?.id]);

  // Автоскролл к последнему сообщению
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadAccounts = async () => {
    try {
      const response = await fetch(`${API_URL}/api/accounts`);
      const data = await response.json();
      const connectedAccounts = data.filter(
        (acc: Account) => acc.status === 'CONNECTED'
      );
      setAccounts(connectedAccounts);

      // Автоматически выбираем первый подключенный аккаунт
      if (connectedAccounts.length > 0 && !selectedAccount) {
        setSelectedAccount(connectedAccounts[0]);
      }
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadChats = async (accountId: string) => {
    // Предотвращаем множественные одновременные запросы
    if (isLoadingChatsRef.current) return;

    isLoadingChatsRef.current = true;

    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/chats`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setChats(data);
    } catch (error) {
      console.error('Failed to load chats:', error);
    } finally {
      isLoadingChatsRef.current = false;
    }
  };

  const loadMessages = async (accountId: string, chatId: string) => {
    // Предотвращаем множественные одновременные запросы
    if (isLoadingMessagesRef.current) return;

    isLoadingMessagesRef.current = true;

    try {
      const encodedChatId = encodeURIComponent(chatId);
      const response = await fetch(
        `${API_URL}/api/accounts/${accountId}/chats/${encodedChatId}`,
        {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setMessages(data);
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      isLoadingMessagesRef.current = false;
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newMessage.trim() || !selectedChat || !selectedAccount) {
      if (!newMessage.trim()) {
        alert('⚠️ Please enter a message');
      }
      return;
    }

    setSending(true);

    try {
      const encodedChatId = encodeURIComponent(selectedChat.chatId);
      const response = await fetch(
        `${API_URL}/api/accounts/${selectedAccount.id}/chats/${encodedChatId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: newMessage.trim() }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to send message' }));

        // If account is connecting, show a helpful message
        if (response.status === 503 && errorData.error?.includes('connecting')) {
          alert('🔄 Account is connecting... Please wait a few seconds and try again.');
        } else {
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        return;
      }

      // Очищаем поле ввода
      setNewMessage('');

      // Перезагружаем сообщения и чаты
      await Promise.all([
        loadMessages(selectedAccount.id, selectedChat.chatId),
        loadChats(selectedAccount.id),
      ]);
    } catch (error: any) {
      console.error('Failed to send message:', error);
      alert(`❌ ${error.message || 'Failed to send message. Please try again.'}`);
    } finally {
      setSending(false);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
      });
    }
  };

  const filteredChats = chats.filter(
    (chat) =>
      chat.contactName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      chat.contactNumber.includes(searchQuery)
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex items-center gap-3 text-white">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-lg">Loading...</span>
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <MessageCircle className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">No Connected Accounts</h2>
          <p className="text-gray-400 mb-6">Connect a WhatsApp account to start chatting</p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-white text-black rounded-lg font-medium hover:bg-gray-200 transition"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-black flex overflow-hidden">
      {/* Sidebar - Список чатов */}
      <div className="w-[400px] bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Header */}
        <div className="bg-gray-800 border-b border-gray-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-gray-700 rounded-lg transition"
            >
              <ArrowLeft className="w-5 h-5 text-white" />
            </button>
            <h2 className="text-lg font-semibold text-white">Chats</h2>
            <button className="p-2 hover:bg-gray-700 rounded-lg transition">
              <MoreVertical className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* Account selector */}
          {accounts.length > 1 && (
            <select
              value={selectedAccount?.id || ''}
              onChange={(e) => {
                const acc = accounts.find((a) => a.id === e.target.value);
                setSelectedAccount(acc || null);
                setSelectedChat(null);
              }}
              className="w-full mb-3 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} {acc.phoneNumber ? `(${acc.phoneNumber})` : ''}
                </option>
              ))}
            </select>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        {/* Chats List */}
        <div className="flex-1 overflow-y-auto">
          {filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <MessageCircle className="w-12 h-12 mb-3" />
              <p>No chats yet</p>
              <p className="text-sm">Send a message to start chatting</p>
            </div>
          ) : (
            filteredChats.map((chat) => (
              <div
                key={chat.chatId}
                onClick={() => setSelectedChat(chat)}
                className={`flex items-center gap-3 p-4 cursor-pointer border-b border-gray-800 transition hover:bg-gray-800 ${
                  selectedChat?.chatId === chat.chatId ? 'bg-gray-800' : ''
                }`}
              >
                {/* Avatar */}
                <div className="w-12 h-12 bg-gray-700 rounded-full flex items-center justify-center flex-shrink-0">
                  <User className="w-6 h-6 text-gray-400" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-semibold text-white truncate">
                      {chat.contactName}
                    </h3>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {formatTime(chat.lastMessageTime)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-400 truncate">
                      {chat.direction === 'OUTGOING' && (
                        <CheckCheck className="w-3 h-3 inline mr-1 text-blue-400" />
                      )}
                      {chat.lastMessage}
                    </p>
                    {chat.unreadCount > 0 && (
                      <span className="bg-green-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0 ml-2">
                        {chat.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {!selectedChat ? (
          <div className="flex-1 flex items-center justify-center bg-gray-900">
            <div className="text-center">
              <MessageCircle className="w-20 h-20 text-gray-700 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-white mb-2">
                WhatsApp Clone
              </h2>
              <p className="text-gray-400">
                Select a chat to start messaging
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="bg-gray-800 border-b border-gray-700 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center">
                  <User className="w-5 h-5 text-gray-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-white">
                    {selectedChat.contactName}
                  </h3>
                  <p className="text-xs text-gray-400">
                    {selectedChat.contactNumber}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 hover:bg-gray-700 rounded-lg transition">
                  <Video className="w-5 h-5 text-white" />
                </button>
                <button className="p-2 hover:bg-gray-700 rounded-lg transition">
                  <Phone className="w-5 h-5 text-white" />
                </button>
                <button className="p-2 hover:bg-gray-700 rounded-lg transition">
                  <MoreVertical className="w-5 h-5 text-white" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              className="flex-1 overflow-y-auto p-4 bg-gray-900"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,.02) 10px, rgba(255,255,255,.02) 20px)',
              }}
            >
              {messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-gray-500">No messages yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, index) => {
                    const isOutgoing = msg.direction === 'OUTGOING';
                    const showDate =
                      index === 0 ||
                      formatDate(messages[index - 1].sentAt) !==
                        formatDate(msg.sentAt);

                    return (
                      <div key={msg.id}>
                        {showDate && (
                          <div className="flex justify-center my-4">
                            <span className="bg-gray-800 text-gray-400 text-xs px-3 py-1 rounded-lg">
                              {formatDate(msg.sentAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex ${
                            isOutgoing ? 'justify-end' : 'justify-start'
                          }`}
                        >
                          <div
                            className={`max-w-[70%] rounded-lg p-3 ${
                              isOutgoing
                                ? 'bg-green-600 text-white'
                                : 'bg-gray-800 text-white'
                            }`}
                          >
                            <p className="text-sm break-words">{msg.message}</p>
                            <div
                              className={`flex items-center justify-end gap-1 mt-1 ${
                                isOutgoing ? 'text-gray-200' : 'text-gray-500'
                              }`}
                            >
                              <span className="text-xs">
                                {formatTime(msg.sentAt)}
                              </span>
                              {isOutgoing && (
                                <>
                                  {msg.status === 'SENT' && (
                                    <Check className="w-3 h-3" />
                                  )}
                                  {msg.status === 'DELIVERED' && (
                                    <CheckCheck className="w-3 h-3" />
                                  )}
                                  {msg.status === 'READ' && (
                                    <CheckCheck className="w-3 h-3 text-blue-400" />
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Message Input */}
            <div className="bg-gray-800 border-t border-gray-700 p-4">
              <form onSubmit={sendMessage} className="flex items-center gap-3">
                <button
                  type="button"
                  className="p-2 hover:bg-gray-700 rounded-lg transition"
                >
                  <Smile className="w-6 h-6 text-gray-400" />
                </button>
                <button
                  type="button"
                  className="p-2 hover:bg-gray-700 rounded-lg transition"
                >
                  <Paperclip className="w-6 h-6 text-gray-400" />
                </button>
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message"
                  disabled={sending}
                  className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim() || sending}
                  className="p-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition"
                >
                  {sending ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <Send className="w-6 h-6" />
                  )}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
