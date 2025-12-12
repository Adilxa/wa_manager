'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Loader2, AlertCircle, RefreshCw } from 'lucide-react';

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

  // Refs для контроля polling
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingRef = useRef(false);
  const accountStatusRef = useRef<string>('');

  const loadAccount = async () => {
    // Предотвращаем множественные одновременные запросы
    if (isLoadingRef.current) return;

    isLoadingRef.current = true;

    try {
      const response = await fetch(`${API_URL}/api/accounts/${accountId}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error('Account not found');
      }

      const data = await response.json();

      // Обновляем ref и state
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

      if (!response.ok) {
        throw new Error('Failed to connect');
      }

      await loadAccount();
    } catch (err) {
      console.error('Failed to connect:', err);
      alert('❌ Failed to connect account. Please try again.');
    }
  };

  const regenerateQR = async () => {
    if (!account) return;

    setRegenerating(true);

    try {
      // Disconnect
      const disconnectRes = await fetch(`${API_URL}/api/accounts/${accountId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!disconnectRes.ok) {
        throw new Error('Failed to disconnect');
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Reconnect
      const connectRes = await fetch(`${API_URL}/api/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!connectRes.ok) {
        throw new Error('Failed to reconnect');
      }

      await loadAccount();
      alert('✅ QR Code regenerated successfully!');
    } catch (err) {
      console.error('Failed to regenerate QR:', err);
      alert('❌ Failed to regenerate QR code. Please try again.');
    } finally {
      setRegenerating(false);
    }
  };

  // Начальная загрузка
  useEffect(() => {
    loadAccount();
  }, []);

  // Умный polling на основе статуса
  useEffect(() => {
    // Очищаем предыдущий интервал
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    // Определяем интервал в зависимости от статуса
    const getPollingInterval = () => {
      const status = accountStatusRef.current;

      if (status === 'CONNECTED') {
        return 10000; // 10 секунд для подключенных
      } else if (['QR_READY', 'CONNECTING', 'AUTHENTICATING'].includes(status)) {
        return 2000; // 2 секунды для активного процесса подключения
      } else {
        return 5000; // 5 секунд по умолчанию
      }
    };

    const interval = setInterval(() => {
      loadAccount();
    }, getPollingInterval());

    pollingIntervalRef.current = interval;

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [account?.clientStatus]);

  // Auto-connect if disconnected on first load
  useEffect(() => {
    if (!loading && account && !autoConnectAttempted) {
      if (account.clientStatus === 'DISCONNECTED') {
        console.log('Auto-connecting disconnected account...');
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
        <div className="flex items-center gap-3 text-white">
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="text-lg">Loading...</span>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white mb-2">Account Not Found</h1>
          <p className="text-gray-400">{error || 'This account does not exist'}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen flex items-center justify-center transition-all duration-1000 ${
        isConnected
          ? 'bg-gradient-to-br from-green-900 via-black to-black'
          : 'bg-black'
      }`}
    >
      <div className="max-w-2xl w-full mx-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              {account.name}
            </h1>
            {account.phoneNumber && (
              <p className="text-gray-400 text-lg">
                {account.phoneNumber}
              </p>
            )}
          </div>

          {/* Status Badge */}
          <div className="flex justify-center mb-8">
            {isConnected ? (
              <div className="flex items-center gap-3 px-6 py-3 bg-green-500/20 border border-green-500/50 rounded-full">
                <CheckCircle2 className="w-6 h-6 text-green-400 animate-pulse" />
                <span className="text-green-400 font-semibold text-lg">Connected Successfully!</span>
              </div>
            ) : hasQR ? (
              <div className="flex items-center gap-3 px-6 py-3 bg-yellow-500/20 border border-yellow-500/50 rounded-full">
                <Loader2 className="w-6 h-6 text-yellow-400 animate-spin" />
                <span className="text-yellow-400 font-semibold text-lg">Waiting for scan...</span>
              </div>
            ) : account?.clientStatus === 'DISCONNECTED' && !autoConnectAttempted ? (
              <div className="flex items-center gap-3 px-6 py-3 bg-blue-500/20 border border-blue-500/50 rounded-full">
                <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                <span className="text-blue-400 font-semibold text-lg">Initializing connection...</span>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-6 py-3 bg-gray-800 border border-gray-700 rounded-full">
                <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
                <span className="text-gray-400 font-semibold text-lg">Connecting...</span>
              </div>
            )}
          </div>

          {/* QR Code or Success Message */}
          {isConnected ? (
            <div className="text-center py-12">
              <div className="inline-block p-6 bg-green-500/10 rounded-full mb-6">
                <CheckCircle2 className="w-24 h-24 text-green-400" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">
                WhatsApp Connected!
              </h2>
              <p className="text-gray-400">
                Your WhatsApp account is now connected and ready to use.
              </p>
            </div>
          ) : hasQR && account.qrCode ? (
            <div className="space-y-6">
              {/* QR Code */}
              <div className="bg-white rounded-xl p-8 flex justify-center">
                <img
                  src={account.qrCode}
                  alt="QR Code"
                  className="w-64 h-64"
                />
              </div>

              {/* Instructions */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
                <h3 className="text-white font-semibold mb-3 text-center">How to Connect:</h3>
                <ol className="text-gray-300 space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="bg-white text-black rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
                    <span>Open WhatsApp on your phone</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="bg-white text-black rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
                    <span>Tap <strong>Settings</strong> → <strong>Linked Devices</strong></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="bg-white text-black rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
                    <span>Tap <strong>Link a Device</strong></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="bg-white text-black rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs font-bold">4</span>
                    <span>Point your phone at this screen to scan the QR code</span>
                  </li>
                </ol>
              </div>

              {/* Regenerate Button */}
              <button
                onClick={regenerateQR}
                disabled={regenerating}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-5 h-5 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating ? 'Regenerating...' : 'Regenerate QR Code'}
              </button>
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="inline-block p-6 bg-gray-800 rounded-full mb-6">
                <Loader2 className="w-24 h-24 text-gray-400 animate-spin" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">
                Connecting...
              </h2>
              <p className="text-gray-400 mb-6">
                Please wait while we establish the connection
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-gray-500 text-sm">
            OCTO WhatsApp Manager
          </p>
        </div>
      </div>
    </div>
  );
}
