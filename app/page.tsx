'use client';

import { useEffect, useState, useRef } from 'react';
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
  Copy,
  Zap,
  Activity,
  Shield,
  MessageSquare,
  Wifi,
  WifiOff,
  Settings,
  MoreVertical,
  X
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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const accountsRef = useRef<Account[]>([]);
  const isLoadingRef = useRef(false);

  // Toast notification
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const isAuth = localStorage.getItem('wa_manager_auth');
    if (!isAuth) {
      router.push('/login');
    }
  }, [router]);

  const loadAccounts = async (showRefreshIndicator = false) => {
    if (isLoadingRef.current && !showRefreshIndicator) return;

    isLoadingRef.current = true;
    if (showRefreshIndicator) setRefreshing(true);

    try {
      const response = await fetch(`${API_URL}/api/accounts`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const data = await response.json();
      accountsRef.current = data;
      setAccounts(data);

      // Update selected account if it exists
      if (selectedAccount) {
        const updated = data.find((a: Account) => a.id === selectedAccount.id);
        if (updated) setSelectedAccount(updated);
      }
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setLoading(false);
      isLoadingRef.current = false;
      if (showRefreshIndicator) setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAccounts();

    const interval = setInterval(() => {
      const currentAccounts = accountsRef.current;
      const hasConnectingAccounts = currentAccounts.some(
        acc => ['CONNECTING', 'AUTHENTICATING', 'QR_READY'].includes(acc.clientStatus)
      );
      if (hasConnectingAccounts) loadAccounts();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const createAccount = async () => {
    if (!newAccountName.trim()) {
      showToast('Please enter an account name', 'error');
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
      setNewAccountName('');
      setUseLimits(true);
      setShowCreateForm(false);
      await loadAccounts(true);
      setSelectedAccount(newAccount);
      showToast('Account created successfully!', 'success');
    } catch (error) {
      console.error('Failed to create account:', error);
      showToast('Failed to create account', 'error');
    }
  };

  const connectAccount = async (accountId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      await loadAccounts(true);
      showToast('Connecting...', 'info');
    } catch (error) {
      console.error('Failed to connect:', error);
      showToast('Failed to connect account', 'error');
    }
  };

  const regenerateQR = async (accountId: string) => {
    setRegeneratingQR(true);
    try {
      await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      await loadAccounts(true);
      showToast('QR Code regenerated!', 'success');
    } catch (error) {
      console.error('Failed to regenerate QR:', error);
      showToast('Failed to regenerate QR code', 'error');
    } finally {
      setRegeneratingQR(false);
    }
  };

  const disconnectAccount = async (accountId: string) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      await loadAccounts(true);
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
      showToast('Account disconnected', 'success');
    } catch (error) {
      console.error('Failed to disconnect:', error);
      showToast('Failed to disconnect account', 'error');
    }
  };

  const toggleUseLimits = async (accountId: string, currentValue: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLimits: !currentValue }),
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const updatedAccount = await response.json();
      await loadAccounts(true);
      if (selectedAccount?.id === accountId) setSelectedAccount(updatedAccount);
      showToast(`Rate limits ${!currentValue ? 'enabled' : 'disabled'}`, 'success');
    } catch (error) {
      console.error('Failed to toggle limits:', error);
      showToast('Failed to update rate limits', 'error');
    }
  };

  const copyQRLink = async (accountId: string) => {
    const link = `${window.location.origin}/qr/${accountId}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('QR link copied!', 'success');
    } catch (error) {
      showToast('Failed to copy link', 'error');
    }
  };

  const deleteAccount = async (accountId: string) => {
    if (!confirm('Are you sure you want to delete this account?')) return;

    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      });

      if (!response.ok) throw new Error('Failed to delete');

      await loadAccounts(true);
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
      showToast('Account deleted', 'success');
    } catch (error: any) {
      console.error('Failed to delete account:', error);
      showToast(`Failed to delete: ${error.message}`, 'error');
    }
  };

  const sendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedAccount) {
      showToast('Please select an account first', 'error');
      return;
    }

    setSending(true);
    const formData = new FormData(e.currentTarget);
    const to = (formData.get('to') as string).trim();
    const message = (formData.get('message') as string).trim();

    if (!to || !message) {
      showToast('Please fill in all fields', 'error');
      setSending(false);
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccount.id, to, message }),
      });

      const data = await response.json();
      if (response.ok) {
        e.currentTarget.reset();
        showToast('Message sent!', 'success');
      } else {
        throw new Error(data.error || 'Failed to send message');
      }
    } catch (error: any) {
      console.error('Failed to send message:', error);
      showToast(error.message || 'Failed to send message', 'error');
    } finally {
      setSending(false);
    }
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'CONNECTED':
        return { color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30', icon: CheckCircle2, label: 'Connected', pulse: false };
      case 'QR_READY':
        return { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', icon: QrCode, label: 'Scan QR', pulse: true };
      case 'CONNECTING':
      case 'AUTHENTICATING':
        return { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: Loader2, label: 'Connecting...', pulse: true };
      case 'FAILED':
        return { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', icon: AlertCircle, label: 'Failed', pulse: false };
      default:
        return { color: 'text-gray-400', bg: 'bg-gray-500/10', border: 'border-gray-500/30', icon: Clock, label: 'Offline', pulse: false };
    }
  };

  // Stats
  const stats = {
    total: accounts.length,
    connected: accounts.filter(a => a.clientStatus === 'CONNECTED').length,
    withLimits: accounts.filter(a => a.useLimits).length,
    pending: accounts.filter(a => ['CONNECTING', 'AUTHENTICATING', 'QR_READY'].includes(a.clientStatus)).length,
  };

  const handleLogout = () => {
    localStorage.removeItem('wa_manager_auth');
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-green-500/20 rounded-full"></div>
            <div className="absolute inset-0 w-16 h-16 border-4 border-transparent border-t-green-500 rounded-full animate-spin"></div>
          </div>
          <p className="text-gray-400 text-sm">Loading accounts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl flex items-center gap-3 shadow-2xl animate-float
          ${toast.type === 'success' ? 'bg-green-500/20 border border-green-500/30 text-green-400' :
            toast.type === 'error' ? 'bg-red-500/20 border border-red-500/30 text-red-400' :
            'bg-blue-500/20 border border-blue-500/30 text-blue-400'}`}>
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5" />}
          {toast.type === 'info' && <Activity className="w-5 h-5" />}
          <span className="font-medium">{toast.message}</span>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-green-500/20">
              <MessageSquare className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold gradient-text">OCTO WhatsApp</h1>
              <p className="text-gray-500 text-sm">Multi-Account Manager</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => loadAccounts(true)}
              disabled={refreshing}
              className="p-2.5 rounded-xl bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-700 transition disabled:opacity-50"
            >
              <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-gray-400 hover:text-white hover:border-gray-700 transition"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <div className="stat-card bg-gray-900/50 border border-gray-800/50 text-gray-400">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-gray-800">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{stats.total}</p>
                <p className="text-xs text-gray-500">Total Accounts</p>
              </div>
            </div>
          </div>

          <div className="stat-card bg-green-500/5 border border-green-500/20 text-green-400">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Wifi className="w-5 h-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-green-400">{stats.connected}</p>
                <p className="text-xs text-green-400/60">Connected</p>
              </div>
            </div>
          </div>

          <div className="stat-card bg-amber-500/5 border border-amber-500/20 text-amber-400">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-400">{stats.withLimits}</p>
                <p className="text-xs text-amber-400/60">With Limits</p>
              </div>
            </div>
          </div>

          <div className="stat-card bg-blue-500/5 border border-blue-500/20 text-blue-400">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-blue-400">{stats.pending}</p>
                <p className="text-xs text-blue-400/60">Pending</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Accounts List - 3 columns */}
          <div className="lg:col-span-3 space-y-4">
            {/* Create Account Button/Form */}
            {!showCreateForm ? (
              <button
                onClick={() => setShowCreateForm(true)}
                className="w-full p-4 rounded-xl border-2 border-dashed border-gray-800 hover:border-green-500/50 hover:bg-green-500/5 transition-all duration-300 flex items-center justify-center gap-3 text-gray-400 hover:text-green-400 group"
              >
                <div className="p-2 rounded-lg bg-gray-900 group-hover:bg-green-500/10 transition">
                  <Plus className="w-5 h-5" />
                </div>
                <span className="font-medium">Add New Account</span>
              </button>
            ) : (
              <div className="glass rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Plus className="w-5 h-5 text-green-400" />
                    Create New Account
                  </h3>
                  <button
                    onClick={() => setShowCreateForm(false)}
                    className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createAccount()}
                    placeholder="Account name..."
                    className="flex-1 px-4 py-3 bg-black/50 border border-gray-800 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 transition"
                    autoFocus
                  />
                  <button
                    onClick={createAccount}
                    disabled={!newAccountName.trim()}
                    className="px-5 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:shadow-lg hover:shadow-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300"
                  >
                    Create
                  </button>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useLimits}
                    onChange={(e) => setUseLimits(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-green-500 focus:ring-green-500/20"
                  />
                  <Shield className="w-3.5 h-3.5" />
                  Use rate limits (recommended)
                </label>
              </div>
            )}

            {/* Accounts */}
            {accounts.length === 0 ? (
              <div className="glass rounded-xl p-12 text-center">
                <div className="w-20 h-20 rounded-2xl bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
                  <Smartphone className="w-10 h-10 text-gray-600" />
                </div>
                <h3 className="text-lg font-medium mb-2">No accounts yet</h3>
                <p className="text-gray-500 text-sm">Create your first WhatsApp account to get started</p>
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
                      className={`group glass rounded-xl p-4 cursor-pointer transition-all duration-300
                        ${isSelected ? 'border-green-500/50 bg-green-500/5 glow-green' : 'hover:border-gray-700'}`}
                    >
                      <div className="flex items-center gap-4">
                        {/* Avatar */}
                        <div className={`relative w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg
                          ${account.clientStatus === 'CONNECTED' ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
                          {account.name.charAt(0).toUpperCase()}
                          {account.clientStatus === 'CONNECTED' && (
                            <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-black"></div>
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold truncate">{account.name}</h3>
                            {account.useLimits && (
                              <Shield className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            )}
                          </div>
                          <p className="text-sm text-gray-500 truncate">
                            {account.phoneNumber || 'Not connected'}
                          </p>
                        </div>

                        {/* Status */}
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${status.bg} ${status.color} ${status.border} border`}>
                          <StatusIcon className={`w-3.5 h-3.5 ${status.label.includes('Connecting') ? 'animate-spin' : ''}`} />
                          {status.label}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 mt-4 pt-3 border-t border-gray-800/50">
                        {account.clientStatus === 'DISCONNECTED' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); connectAccount(account.id); }}
                            className="flex-1 py-2 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 transition flex items-center justify-center gap-2"
                          >
                            <Link className="w-3.5 h-3.5" />
                            Connect
                          </button>
                        )}

                        {account.hasActiveClient && account.clientStatus !== 'DISCONNECTED' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); disconnectAccount(account.id); }}
                            className="flex-1 py-2 rounded-lg bg-amber-500/10 text-amber-400 text-sm font-medium hover:bg-amber-500/20 transition flex items-center justify-center gap-2"
                          >
                            <WifiOff className="w-3.5 h-3.5" />
                            Disconnect
                          </button>
                        )}

                        <button
                          onClick={(e) => { e.stopPropagation(); copyQRLink(account.id); }}
                          className="p-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition"
                          title="Copy QR Link"
                        >
                          <Copy className="w-4 h-4" />
                        </button>

                        <button
                          onClick={(e) => { e.stopPropagation(); deleteAccount(account.id); }}
                          className="p-2 rounded-lg bg-gray-800 text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Account Details - 2 columns */}
          <div className="lg:col-span-2">
            <div className="glass rounded-xl p-5 sticky top-6">
              {!selectedAccount ? (
                <div className="text-center py-16">
                  <div className="w-20 h-20 rounded-2xl bg-gray-800/50 flex items-center justify-center mx-auto mb-4">
                    <Smartphone className="w-10 h-10 text-gray-600" />
                  </div>
                  <h3 className="text-lg font-medium mb-2">No Account Selected</h3>
                  <p className="text-gray-500 text-sm">Select an account to view details</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`w-14 h-14 rounded-xl flex items-center justify-center font-bold text-xl
                        ${selectedAccount.clientStatus === 'CONNECTED' ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
                        {selectedAccount.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-bold text-lg">{selectedAccount.name}</h3>
                        <p className="text-gray-500 text-sm">{selectedAccount.phoneNumber || 'Not linked'}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedAccount(null)}
                      className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Status */}
                  {(() => {
                    const s = getStatusConfig(selectedAccount.clientStatus);
                    const Icon = s.icon;
                    return (
                      <div className={`flex items-center gap-3 p-3 rounded-xl ${s.bg} ${s.border} border`}>
                        <Icon className={`w-5 h-5 ${s.color} ${s.label.includes('Connecting') ? 'animate-spin' : ''}`} />
                        <div>
                          <p className={`font-medium ${s.color}`}>{s.label}</p>
                          <p className="text-xs text-gray-500">Current status</p>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Rate Limits Toggle */}
                  <div className="flex items-center justify-between p-3 rounded-xl bg-gray-800/30 border border-gray-800">
                    <div className="flex items-center gap-3">
                      <Shield className={`w-5 h-5 ${selectedAccount.useLimits ? 'text-amber-400' : 'text-gray-500'}`} />
                      <div>
                        <p className="font-medium">Rate Limits</p>
                        <p className="text-xs text-gray-500">
                          {selectedAccount.useLimits ? 'Safe mode enabled' : 'No restrictions'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => toggleUseLimits(selectedAccount.id, selectedAccount.useLimits)}
                      className={`relative w-12 h-7 rounded-full transition-colors ${selectedAccount.useLimits ? 'bg-amber-500' : 'bg-gray-700'}`}
                    >
                      <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${selectedAccount.useLimits ? 'left-6' : 'left-1'}`} />
                    </button>
                  </div>

                  {/* QR Code */}
                  {selectedAccount.qrCode && (
                    <div className="bg-black/50 rounded-xl p-4 text-center border border-gray-800">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="font-semibold flex items-center gap-2 text-sm">
                          <QrCode className="w-4 h-4 text-amber-400" />
                          Scan to Connect
                        </h4>
                        <button
                          onClick={() => regenerateQR(selectedAccount.id)}
                          disabled={regeneratingQR}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 rounded-lg text-xs text-gray-400 hover:text-white transition disabled:opacity-50"
                        >
                          <RefreshCw className={`w-3 h-3 ${regeneratingQR ? 'animate-spin' : ''}`} />
                          Refresh
                        </button>
                      </div>
                      <div className="inline-block p-3 bg-white rounded-xl">
                        <img src={selectedAccount.qrCode} alt="QR Code" className="w-44 h-44" />
                      </div>
                      <p className="text-xs text-gray-500 mt-3">
                        WhatsApp &rarr; Settings &rarr; Linked Devices
                      </p>
                    </div>
                  )}

                  {/* Send Message */}
                  {selectedAccount.clientStatus === 'CONNECTED' && (
                    <div className="space-y-3">
                      <h4 className="font-semibold flex items-center gap-2 text-sm">
                        <Send className="w-4 h-4 text-green-400" />
                        Send Message
                      </h4>
                      <form onSubmit={sendMessage} className="space-y-3">
                        <input
                          type="text"
                          name="to"
                          placeholder="Phone number (e.g. 1234567890)"
                          required
                          className="w-full px-4 py-3 bg-black/50 border border-gray-800 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 transition text-sm"
                        />
                        <textarea
                          name="message"
                          placeholder="Type your message..."
                          required
                          rows={3}
                          className="w-full px-4 py-3 bg-black/50 border border-gray-800 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 transition resize-none text-sm"
                        />
                        <button
                          type="submit"
                          disabled={sending}
                          className="w-full py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:shadow-lg hover:shadow-green-500/20 disabled:opacity-50 transition-all duration-300 flex items-center justify-center gap-2"
                        >
                          {sending ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Sending...
                            </>
                          ) : (
                            <>
                              <Send className="w-4 h-4" />
                              Send
                            </>
                          )}
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Account ID */}
                  <div className="pt-3 border-t border-gray-800">
                    <p className="text-xs text-gray-600">Account ID</p>
                    <p className="text-xs font-mono text-gray-500 truncate">{selectedAccount.id}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
