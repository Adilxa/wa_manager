'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  QrCode,
  Send,
  Trash2,
  LogOut,
  Link,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Smartphone,
  Clock,
  User,
  Hash,
  RefreshCw,
  Copy
} from 'lucide-react';

interface Account {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  qrCode: string | null;
  clientStatus: string;
  hasActiveClient: boolean;
  useLimits: boolean;
  createdAt: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function Dashboard() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [regeneratingQR, setRegeneratingQR] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [sending, setSending] = useState(false);
  const [useLimits, setUseLimits] = useState(true);

  // Refs для отслеживания состояния без ре-рендеров
  const accountsRef = useRef<Account[]>([]);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingRef = useRef(false);

  // Проверка авторизации
  useEffect(() => {
    const isAuth = localStorage.getItem('wa_manager_auth');
    if (!isAuth) {
      router.push('/login');
    }

  }, [router]);

  // Загрузка аккаунтов с защитой от множественных запросов
  const loadAccounts = async (showRefreshIndicator = false) => {
    // Предотвращаем множественные одновременные запросы
    if (isLoadingRef.current && !showRefreshIndicator) {
      return;
    }

    isLoadingRef.current = true;
    if (showRefreshIndicator) setRefreshing(true);

    try {
      const response = await fetch(`${API_URL}/api/accounts`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // Обновляем ref и state
      accountsRef.current = data;
      setAccounts(data);

    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
      isLoadingRef.current = false;
      if (showRefreshIndicator) setRefreshing(false);
    }
  };

  // Начальная загрузка и polling
  useEffect(() => {
    // Начальная загрузка
    loadAccounts();

    // Умный polling - обновляем только когда есть активные процессы
    const interval = setInterval(() => {
      const currentAccounts = accountsRef.current;

      // Проверяем есть ли аккаунты в процессе подключения
      const hasConnectingAccounts = currentAccounts.some(
        acc => ['CONNECTING', 'AUTHENTICATING', 'QR_READY'].includes(acc.clientStatus)
      );

      // Обновляем только если есть активные процессы подключения
      if (hasConnectingAccounts) {
        loadAccounts();
      }
    }, 5000); // Проверяем каждые 5 секунд

    pollingIntervalRef.current = interval;

    // Cleanup
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, []); // Только при монтировании

  // Создание аккаунта
  const createAccount = async () => {
    if (!newAccountName.trim()) {
      alert('⚠️ Please enter an account name');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newAccountName.trim(), useLimits }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to create account' }));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const newAccount = await response.json();

      // Очищаем форму
      setNewAccountName('');
      setUseLimits(true);

      // Обновляем список
      await loadAccounts(true);

      // Автоматически выбираем новый аккаунт
      setSelectedAccount(newAccount);

      alert('✅ Account created successfully!');
    } catch (error) {
      console.error('Failed to create account:', error);
      alert('❌ Failed to create account. Please try again.');
    }
  };

  // Подключение
  const connectAccount = async (accountId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await loadAccounts(true);
    } catch (error) {
      console.error('Failed to connect:', error);
      alert('❌ Failed to connect account. Please try again.');
    }
  };

  // Регенерация QR кода (переподключение)
  const regenerateQR = async (accountId: string) => {
    setRegeneratingQR(true);
    try {
      // Сначала отключаем
      const disconnectRes = await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!disconnectRes.ok) {
        throw new Error('Failed to disconnect');
      }

      // Ждем немного
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Затем снова подключаем
      const connectRes = await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!connectRes.ok) {
        throw new Error('Failed to reconnect');
      }

      await loadAccounts(true);
      alert('✅ QR Code regenerated successfully!');
    } catch (error) {
      console.error('Failed to regenerate QR:', error);
      alert('❌ Failed to regenerate QR code. Please try again.');
    } finally {
      setRegeneratingQR(false);
    }
  };

  // Отключение
  const disconnectAccount = async (accountId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await loadAccounts(true);

      if (selectedAccount?.id === accountId) {
        setSelectedAccount(null);
      }

      alert('✅ Account disconnected successfully!');
    } catch (error) {
      console.error('Failed to disconnect:', error);
      alert('❌ Failed to disconnect account. Please try again.');
    }
  };

  // Изменение useLimits
  const toggleUseLimits = async (accountId: string, currentValue: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLimits: !currentValue }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const updatedAccount = await response.json();

      await loadAccounts(true);

      // Обновляем выбранный аккаунт если это он
      if (selectedAccount?.id === accountId) {
        setSelectedAccount(updatedAccount);
      }

      alert(`✅ Rate limits ${!currentValue ? 'enabled' : 'disabled'} successfully!`);
    } catch (error) {
      console.error('Failed to toggle limits:', error);
      alert('❌ Failed to update rate limits. Please try again.');
    }
  };

  // Копирование ссылки на QR
  const copyQRLink = async (accountId: string) => {
    const link = `${window.location.origin}/qr/${accountId}`;
    try {
      await navigator.clipboard.writeText(link);
      alert('✅ QR link copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy link:', error);
      // Fallback для старых браузеров
      const textArea = document.createElement('textarea');
      textArea.value = link;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        alert('✅ QR link copied to clipboard!');
      } catch (err) {
        alert('❌ Failed to copy link. Please copy manually: ' + link);
      }
      document.body.removeChild(textArea);
    }
  };

  // Удаление
  const deleteAccount = async (accountId: string) => {
    if (!confirm('Are you sure you want to delete this account? This action cannot be undone.')) return;

    console.log('🗑️ Starting delete for account:', accountId);

    try {
      const deleteUrl = `${API_URL}/api/accounts/${accountId}`;
      console.log('DELETE URL:', deleteUrl);

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      console.log('DELETE Response status:', response.status);
      console.log('DELETE Response ok:', response.ok);

      // Попытка прочитать тело ответа
      let responseData;
      try {
        const text = await response.text();
        console.log('DELETE Response text:', text);
        responseData = text ? JSON.parse(text) : {};
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        responseData = {};
      }

      if (!response.ok) {
        const errorMessage = responseData.error || `HTTP error! status: ${response.status}`;
        console.error('DELETE failed:', errorMessage);
        throw new Error(errorMessage);
      }

      console.log('✅ DELETE successful, response:', responseData);

      // Успешно удалено - обновляем список
      await loadAccounts(true);

      // Если удален выбранный аккаунт, снимаем выбор
      if (selectedAccount?.id === accountId) {
        setSelectedAccount(null);
      }

      alert('✅ Account deleted successfully!');
    } catch (error: any) {
      console.error('❌ Failed to delete account:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
      });
      alert(`❌ Failed to delete account: ${error.message || 'Unknown error'}`);
    }
  };

  // Отправка сообщения
  const sendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!selectedAccount) {
      alert('⚠️ Please select an account first');
      return;
    }

    setSending(true);

    const formData = new FormData(e.currentTarget);
    const to = (formData.get('to') as string).trim();
    const message = (formData.get('message') as string).trim();

    if (!to || !message) {
      alert('⚠️ Please fill in all fields');
      setSending(false);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccount.id,
          to,
          message,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        e.currentTarget.reset();
        alert('✅ Message sent successfully!');
      } else {
        throw new Error(data.error || 'Failed to send message');
      }
    } catch (error: any) {
      console.error('Failed to send message:', error);
      alert(`❌ ${error.message || 'Failed to send message. Please try again.'}`);
    } finally {
      setSending(false);
    }
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'CONNECTED':
        return { color: 'text-green-400', bg: 'bg-green-400/10', icon: CheckCircle2, label: 'Connected' };
      case 'QR_READY':
        return { color: 'text-yellow-400', bg: 'bg-yellow-400/10', icon: QrCode, label: 'Scan QR' };
      case 'CONNECTING':
      case 'AUTHENTICATING':
        return { color: 'text-blue-400', bg: 'bg-blue-400/10', icon: Loader2, label: 'Connecting...' };
      case 'FAILED':
        return { color: 'text-red-400', bg: 'bg-red-400/10', icon: AlertCircle, label: 'Failed' };
      default:
        return { color: 'text-gray-400', bg: 'bg-gray-400/10', icon: Clock, label: 'Disconnected' };
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex items-center gap-3 text-white">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-lg">Loading accounts...</span>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    localStorage.removeItem('wa_manager_auth');
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-10 flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              WhatsApp API
            </h1>
            <p className="text-gray-400 mt-2">Manage multiple WhatsApp accounts with ease</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-gray-400 hover:text-white hover:border-gray-700 transition"
            >
              <LogOut className="w-4 h-4" />
              Logout
            </button>
          </div>
        </div>

        {/* Create Account */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Create New Account
          </h2>
          <div className="space-y-3">
            <div className="flex gap-3">
              <input
                type="text"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createAccount()}
                placeholder="Enter account name..."
                className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/50 transition"
              />
              <button
                onClick={createAccount}
                disabled={!newAccountName.trim()}
                className="px-6 py-3 bg-white text-black rounded-lg font-medium hover:bg-gray-200 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Create
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={useLimits}
                onChange={(e) => setUseLimits(e.target.checked)}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-white focus:ring-2 focus:ring-white/20"
              />
              <span>Use rate limits (recommended for new accounts)</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Accounts List */}
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Smartphone className="w-5 h-5" />
                Accounts
                <span className="text-sm text-gray-400 font-normal">({accounts.length})</span>
              </h2>
              <button
                onClick={() => loadAccounts(true)}
                disabled={refreshing}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white hover:border-gray-600 transition text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            {accounts.length === 0 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
                <div className="bg-gray-800 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Smartphone className="w-8 h-8 text-gray-600" />
                </div>
                <p className="text-gray-400">No accounts yet. Create one to get started.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {accounts.map((account) => {
                  const status = getStatusConfig(account.clientStatus);
                  const StatusIcon = status.icon;
                  const isSelected = selectedAccount?.id === account.id;

                  return (
                    <div
                      key={account.id}
                      onClick={() => setSelectedAccount(account)}
                      className={`group bg-gray-900 border rounded-xl p-5 cursor-pointer transition-all duration-200
                        ${isSelected
                          ? 'border-white bg-white/5 shadow-xl shadow-white/5'
                          : 'border-gray-800 hover:border-gray-700 hover:bg-gray-800/50'
                        }`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <h3 className="font-semibold text-lg flex items-center gap-2">
                            <User className="w-4 h-4 text-gray-500" />
                            {account.name}
                          </h3>
                          {account.phoneNumber && (
                            <p className="text-sm text-gray-400 mt-1 flex items-center gap-1">
                              <Hash className="w-3 h-3" />
                              {account.phoneNumber}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${account.useLimits ? 'bg-yellow-500/10 text-yellow-400' : 'bg-green-500/10 text-green-400'}`}>
                              {account.useLimits ? '⚡ With Limits' : '🚀 No Limits'}
                            </span>
                          </div>
                        </div>
                        <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${status.bg} ${status.color}`}>
                          <StatusIcon className={`w-3 h-3 ${status.label.includes('Connecting') ? 'animate-spin' : ''}`} />
                          {status.label}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        {account.clientStatus === 'DISCONNECTED' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              connectAccount(account.id);
                            }}
                            className="flex-1 py-2 bg-green-500/10 text-green-400 rounded-lg text-sm font-medium hover:bg-green-500/20 transition flex items-center justify-center gap-1"
                          >
                            <Link className="w-3 h-3" />
                            Connect
                          </button>
                        )}

                        {account.hasActiveClient && account.clientStatus !== 'DISCONNECTED' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              disconnectAccount(account.id);
                            }}
                            className="flex-1 py-2 bg-yellow-500/10 text-yellow-400 rounded-lg text-sm font-medium hover:bg-yellow-500/20 transition flex items-center justify-center gap-1"
                          >
                            <LogOut className="w-3 h-3" />
                            Disconnect
                          </button>
                        )}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyQRLink(account.id);
                          }}
                          className="px-3 py-2 bg-blue-500/10 text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-500/20 transition flex items-center gap-1"
                          title="Copy QR Link"
                        >
                          <Copy className="w-3 h-3" />
                        </button>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteAccount(account.id);
                          }}
                          className="px-3 py-2 bg-red-500/10 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/20 transition flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Account Details */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 backdrop-blur-sm">
            <h2 className="text-xl font-semibold mb-4">Account Details</h2>

            {!selectedAccount ? (
              <div className="text-center py-12">
                <div className="bg-gray-800 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Smartphone className="w-10 h-10 text-gray-600" />
                </div>
                <p className="text-gray-400">Select an account to view details</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Info */}
                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-gray-500">Name</p>
                    <p className="text-lg font-medium">{selectedAccount.name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">ID</p>
                    <p className="text-sm font-mono text-gray-400">{selectedAccount.id}</p>
                  </div>
                  {selectedAccount.phoneNumber && (
                    <div>
                      <p className="text-sm text-gray-500">Phone</p>
                      <p className="text-lg font-medium">{selectedAccount.phoneNumber}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-gray-500">Status</p>
                    <div className="flex items-center gap-2 mt-1">
                      {(() => {
                        const s = getStatusConfig(selectedAccount.clientStatus);
                        const Icon = s.icon;
                        return (
                          <>
                            <div className={`p-1.5 rounded-full ${s.bg}`}>
                              <Icon className={`w-4 h-4 ${s.color} ${s.label.includes('Connecting') ? 'animate-spin' : ''}`} />
                            </div>
                            <span className={`font-medium ${s.color}`}>{s.label}</span>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Rate Limits Toggle */}
                  <div className="pt-3 border-t border-gray-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-500">Rate Limits</p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {selectedAccount.useLimits ? 'Limited sending (safe)' : 'Unlimited sending'}
                        </p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleUseLimits(selectedAccount.id, selectedAccount.useLimits);
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${selectedAccount.useLimits ? 'bg-yellow-500' : 'bg-green-500'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${selectedAccount.useLimits ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </button>
                    </div>
                  </div>
                </div>

                {/* QR Code */}
                {selectedAccount.qrCode && (
                  <div className="bg-black/50 border border-gray-800 rounded-xl p-6 text-center">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="font-semibold flex items-center gap-2">
                        <QrCode className="w-5 h-5" />
                        Scan to Connect
                      </h4>
                      <button
                        onClick={() => regenerateQR(selectedAccount.id)}
                        disabled={regeneratingQR}
                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${regeneratingQR ? 'animate-spin' : ''}`} />
                        {regeneratingQR ? 'Regenerating...' : 'Regenerate'}
                      </button>
                    </div>
                    <div className="inline-block p-4 bg-white rounded-xl">
                      <img
                        src={selectedAccount.qrCode}
                        alt="QR Code"
                        className="w-48 h-48"
                      />
                    </div>
                    <p className="text-sm text-gray-400 mt-3">
                      Open WhatsApp → Settings → Linked Devices → Link a Device
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      QR code expired? Click "Regenerate" to get a new one
                    </p>
                  </div>
                )}

                {/* Send Message */}
                {selectedAccount.clientStatus === 'CONNECTED' && (
                  <div>
                    <h4 className="font-semibold mb-4 flex items-center gap-2">
                      <Send className="w-5 h-5" />
                      Send Message
                    </h4>
                    <form onSubmit={sendMessage} className="space-y-4">
                      <input
                        type="text"
                        name="to"
                        placeholder="Recipient phone (e.g. 1234567890)"
                        required
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/50 transition"
                      />
                      <textarea
                        name="message"
                        placeholder="Type your message..."
                        required
                        rows={4}
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/50 transition resize-none"
                      />
                      <button
                        type="submit"
                        disabled={sending}
                        className="w-full py-3 bg-white text-black rounded-lg font-medium hover:bg-gray-200 disabled:bg-gray-800 disabled:text-gray-500 transition flex items-center justify-center gap-2"
                      >
                        {sending ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Send className="w-4 h-4" />
                            Send Message
                          </>
                        )}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}