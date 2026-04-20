'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw, MessageSquare, Smartphone, QrCode } from 'lucide-react';

interface Account {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  qrCode: string | null;
  clientStatus: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function QRPage() {
  const params = useParams();
  const accountId = params.id as string;

  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingRef = useRef(false);
  const accountStatusRef = useRef<string>('');

  const loadAccount = async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!response.ok) throw new Error('Account not found');

      const data = await response.json();
      accountStatusRef.current = data.clientStatus;
      setAccount(data);
      setError(null);
    } catch (err) {
      setError('Failed to load account');
      console.error('Failed to load account:', err);
    } finally {
      setLoading(false);
      isLoadingRef.current = false;
    }
  };

  const connectAccount = async () => {
    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error('Failed to connect');
      await loadAccount();
    } catch (err) {
      console.error('Failed to connect:', err);
    }
  };

  const regenerateQR = async () => {
    if (!account) return;
    setRegenerating(true);

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

      await loadAccount();
    } catch (err) {
      console.error('Failed to regenerate QR:', err);
    } finally {
      setRegenerating(false);
    }
  };

  useEffect(() => {
    loadAccount();
  }, []);

  useEffect(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    const getPollingInterval = () => {
      const status = accountStatusRef.current;
      if (status === 'CONNECTED') return 10000;
      if (['QR_READY', 'CONNECTING', 'AUTHENTICATING'].includes(status)) return 2000;
      return 5000;
    };

    const interval = setInterval(() => loadAccount(), getPollingInterval());
    pollingIntervalRef.current = interval;

    return () => { if (interval) clearInterval(interval); };
  }, [account?.clientStatus]);

  useEffect(() => {
    if (!loading && account && !autoConnectAttempted) {
      if (account.clientStatus === 'DISCONNECTED') {
        setAutoConnectAttempted(true);
        connectAccount();
      }
    }
  }, [loading, account?.clientStatus, autoConnectAttempted]);

  const isConnected = account?.clientStatus === 'CONNECTED';
  const hasQR = account?.qrCode && ['QR_READY', 'CONNECTING', 'AUTHENTICATING'].includes(account?.clientStatus || '');

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-green-500/20 rounded-full"></div>
            <div className="absolute inset-0 w-16 h-16 border-4 border-transparent border-t-green-500 rounded-full animate-spin"></div>
          </div>
          <p className="text-gray-400 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-4">
        <div className="text-center">
          <div className="w-20 h-20 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="w-10 h-10 text-red-400" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Account Not Found</h1>
          <p className="text-gray-500">{error || 'This account does not exist'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background effects */}
      {isConnected && (
        <>
          <div className="absolute inset-0 bg-gradient-to-br from-green-500/10 via-transparent to-emerald-500/5" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-green-500/10 rounded-full blur-3xl" />
        </>
      )}

      <div className="max-w-lg w-full relative z-10">
        <div className="glass rounded-2xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <div className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 transition-colors duration-500
              ${isConnected ? 'bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg shadow-green-500/20' : 'bg-gray-800'}`}>
              {isConnected ? (
                <CheckCircle2 className="w-8 h-8 text-white" />
              ) : (
                <MessageSquare className="w-8 h-8 text-gray-400" />
              )}
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">{account.name}</h1>
            {account.phoneNumber && (
              <p className="text-gray-500">{account.phoneNumber}</p>
            )}
          </div>

          {/* Status Badge */}
          <div className="flex justify-center mb-8">
            {isConnected ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/30 rounded-xl">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-green-400 font-medium">Connected</span>
              </div>
            ) : hasQR ? (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <QrCode className="w-4 h-4 text-amber-400" />
                <span className="text-amber-400 font-medium">Scan QR Code</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                <span className="text-blue-400 font-medium">Connecting...</span>
              </div>
            )}
          </div>

          {/* Content */}
          {isConnected ? (
            <div className="text-center py-8">
              <div className="w-24 h-24 rounded-2xl bg-green-500/10 flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-12 h-12 text-green-400" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">WhatsApp Connected!</h2>
              <p className="text-gray-500 text-sm">Your account is ready to use</p>
            </div>
          ) : hasQR && account.qrCode ? (
            <div className="space-y-6">
              {/* QR Code */}
              <div className="flex justify-center">
                <div className="p-4 bg-white rounded-2xl shadow-xl">
                  <img src={account.qrCode} alt="QR Code" className="w-56 h-56" />
                </div>
              </div>

              {/* Instructions */}
              <div className="bg-black/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-3 text-sm text-gray-400">
                  <div className="w-6 h-6 rounded-lg bg-gray-800 flex items-center justify-center text-xs font-bold text-white">1</div>
                  <span>Open WhatsApp on your phone</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-gray-400">
                  <div className="w-6 h-6 rounded-lg bg-gray-800 flex items-center justify-center text-xs font-bold text-white">2</div>
                  <span>Go to Settings &rarr; Linked Devices</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-gray-400">
                  <div className="w-6 h-6 rounded-lg bg-gray-800 flex items-center justify-center text-xs font-bold text-white">3</div>
                  <span>Tap "Link a Device" and scan this code</span>
                </div>
              </div>

              {/* Regenerate Button */}
              <button
                onClick={regenerateQR}
                disabled={regenerating}
                className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating ? 'Refreshing...' : 'Refresh QR Code'}
              </button>
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="w-24 h-24 rounded-2xl bg-gray-800/50 flex items-center justify-center mx-auto mb-6">
                <Loader2 className="w-12 h-12 text-gray-400 animate-spin" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Initializing...</h2>
              <p className="text-gray-500 text-sm">Please wait while we establish connection</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-gray-600 text-xs">OCTO WhatsApp Manager</p>
        </div>
      </div>
    </div>
  );
}
