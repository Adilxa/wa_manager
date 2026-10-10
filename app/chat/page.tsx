'use client';

import { useEffect, useState, useRef } from 'react';
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
import { useAccounts, useChats, useChatMessages } from '@/lib/hooks/useWebSocket';

interface Account {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  clientStatus?: string;
}

interface Chat {
  chatId: string;
  contactNumber: string;
  contactName: string | null;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  direction: string;
  messages?: any[];
}

export default function ChatPage() {
  const router = useRouter();
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // WebSocket hooks
  const { accounts, loading } = useAccounts();
  const { chats } = useChats(selectedAccount?.id || null);
  const { messages, sendMessage: sendMessageWS } = useChatMessages(selectedAccount?.id || null, selectedChat?.chatId || null);

  // Filter connected accounts
  const connectedAccounts = accounts.filter((acc: Account) => acc.clientStatus === 'CONNECTED');

  // Check authentication
  useEffect(() => {
    const isAuth = localStorage.getItem('wa_manager_auth');
    if (!isAuth) {
      router.push('/login');
    }
  }, [router]);

  // Auto-select first connected account
  useEffect(() => {
    if (connectedAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(connectedAccounts[0]);
    }
  }, [connectedAccounts, selectedAccount]);

  // Автоскролл к последнему сообщению
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
      // Send via WebSocket
      await sendMessageWS(newMessage.trim());

      // Clear input
      setNewMessage('');
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
      (chat.contactName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (chat.contactNumber || '').includes(searchQuery)
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-900">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-lg">Loading...</span>
        </div>
      </div>
    );
  }

  if (connectedAccounts.length === 0 && !loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <MessageCircle className="w-16 h-16 text-gray-400 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No Connected Accounts</h2>
          <p className="text-gray-600 mb-6">Connect a WhatsApp account to start chatting</p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 flex overflow-hidden">
      {/* Sidebar - Список чатов */}
      <div className="w-[400px] bg-white border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="bg-gray-100 border-b border-gray-300 p-4">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-gray-200 rounded-lg transition"
            >
              <ArrowLeft className="w-5 h-5 text-gray-900" />
            </button>
            <h2 className="text-lg font-semibold text-gray-900">Chats</h2>
            <button className="p-2 hover:bg-gray-200 rounded-lg transition">
              <MoreVertical className="w-5 h-5 text-gray-900" />
            </button>
          </div>

          {/* Account selector */}
          {connectedAccounts.length > 1 && (
            <select
              value={selectedAccount?.id || ''}
              onChange={(e) => {
                const acc = connectedAccounts.find((a) => a.id === e.target.value);
                setSelectedAccount(acc || null);
                setSelectedChat(null);
              }}
              className="w-full mb-3 px-3 py-2 bg-gray-200 border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              {connectedAccounts.map((acc) => (
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
              className="w-full pl-10 pr-4 py-2 bg-gray-200 border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
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
                className={`flex items-center gap-3 p-4 cursor-pointer border-b border-gray-200 transition hover:bg-gray-100 ${
                  selectedChat?.chatId === chat.chatId ? 'bg-gray-100' : ''
                }`}
              >
                {/* Avatar */}
                <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0">
                  <User className="w-6 h-6 text-gray-600" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-semibold text-gray-900 truncate">
                      {chat.contactName || chat.contactNumber}
                    </h3>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {formatTime(chat.lastMessageTime)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600 truncate">
                      {chat.direction === 'OUTGOING' && (
                        <CheckCheck className="w-3 h-3 inline mr-1 text-blue-600" />
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
          <div className="flex-1 flex items-center justify-center bg-white">
            <div className="text-center">
              <MessageCircle className="w-20 h-20 text-gray-300 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                WhatsApp Clone
              </h2>
              <p className="text-gray-600">
                Select a chat to start messaging
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="bg-gray-100 border-b border-gray-300 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
                  <User className="w-5 h-5 text-gray-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">
                    {selectedChat.contactName || selectedChat.contactNumber}
                  </h3>
                  <p className="text-xs text-gray-600">
                    {selectedChat.contactNumber}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button className="p-2 hover:bg-gray-200 rounded-lg transition">
                  <Video className="w-5 h-5 text-gray-900" />
                </button>
                <button className="p-2 hover:bg-gray-200 rounded-lg transition">
                  <Phone className="w-5 h-5 text-gray-900" />
                </button>
                <button className="p-2 hover:bg-gray-200 rounded-lg transition">
                  <MoreVertical className="w-5 h-5 text-gray-900" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              className="flex-1 overflow-y-auto p-4 bg-white"
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
                            <span className="bg-gray-100 text-gray-600 text-xs px-3 py-1 rounded-lg">
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
                                : 'bg-gray-100 text-gray-900'
                            }`}
                          >
                            <p className="text-sm break-words">{msg.message}</p>
                            <div
                              className={`flex items-center justify-end gap-1 mt-1 ${
                                isOutgoing ? 'text-gray-800' : 'text-gray-500'
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
                                    <CheckCheck className="w-3 h-3 text-blue-600" />
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
            <div className="bg-gray-100 border-t border-gray-300 p-4">
              <form onSubmit={sendMessage} className="flex items-center gap-3">
                <button
                  type="button"
                  className="p-2 hover:bg-gray-200 rounded-lg transition"
                >
                  <Smile className="w-6 h-6 text-gray-600" />
                </button>
                <button
                  type="button"
                  className="p-2 hover:bg-gray-200 rounded-lg transition"
                >
                  <Paperclip className="w-6 h-6 text-gray-600" />
                </button>
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message"
                  disabled={sending}
                  className="flex-1 px-4 py-3 bg-gray-200 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim() || sending}
                  className="p-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition"
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
