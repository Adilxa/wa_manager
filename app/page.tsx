'use client';

import { useEffect, useState } from 'react';
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
  Hash
} from 'lucide-react';

interface Account {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  qrCode: string | null;
  clientStatus: string;
  hasActiveClient: boolean;
  createdAt: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function Dashboard() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAccountName, setNewAccountName] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);
  const [sending, setSending] = useState(false);

  // Проверка авторизации
  useEffect(() => {
    const isAuth = localStorage.getItem('wa_manager_auth');
    if (!isAuth) {
      router.push('/login');
    }
  }, [router]);

  // Загрузка аккаунтов
  const loadAccounts = async () => {
    try {
      const response = await fetch(`${API_URL}/api/accounts`);
      const data = await response.json();
      setAccounts(data);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 3000);
    setRefreshInterval(interval);
    return () => interval && clearInterval(interval);
  }, []);

  // Создание аккаунта
  const createAccount = async () => {
    if (!newAccountName.trim()) return;
    try {
      const response = await fetch(`${API_URL}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newAccountName }),
      });
      if (response.ok) {
        setNewAccountName('');
        await loadAccounts();
      }
    } catch (error) {
      console.error('Failed to create account:', error);
    }
  };

  // Подключение
  const connectAccount = async (accountId: string) => {
    try {
      await fetch(`${API_URL}/api/accounts/${accountId}/connect`, { method: 'POST' });
      await loadAccounts();
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  // Отключение
  const disconnectAccount = async (accountId: string) => {
    try {
      await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, { method: 'POST' });
      await loadAccounts();
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  };

  // Удаление
  const deleteAccount = async (accountId: string) => {
    if (!confirm('Delete this account?')) return;
    try {
      await fetch(`${API_URL}/api/accounts/${accountId}`, { method: 'DELETE' });
      await loadAccounts();
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  };

  // Отправка сообщения
  const sendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedAccount) return;
    setSending(true);
    const formData = new FormData(e.currentTarget);
    const to = formData.get('to') as string;
    const message = formData.get('message') as string;

    try {
      const response = await fetch(`${API_URL}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccount.id, to, message }),
      });
      const data = await response.json();
      if (response.ok) {
        e.currentTarget.reset();
        alert('Message sent!');
      } else {
        alert(data.error || 'Failed to send');
      }
    } catch (error) {
      alert('Sent success');
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
              WhatsApp Manager
            </h1>
            <p className="text-gray-400 mt-2">Manage multiple WhatsApp accounts with ease</p>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-gray-400 hover:text-white hover:border-gray-700 transition"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>

        {/* Create Account */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8 backdrop-blur-sm">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Create New Account
          </h2>
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
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Accounts List */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Smartphone className="w-5 h-5" />
                Accounts
              </span>
              <span className="text-sm text-gray-400">{accounts.length}</span>
            </h2>

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
                </div>

                {/* QR Code */}
                {selectedAccount.qrCode && (
                  <div className="bg-black/50 border border-gray-800 rounded-xl p-6 text-center">
                    <h4 className="font-semibold mb-4 flex items-center justify-center gap-2">
                      <QrCode className="w-5 h-5" />
                      Scan to Connect
                    </h4>
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