import { Client } from 'whatsapp-web.js';

export interface WhatsAppClientInfo {
  accountId: string;
  client: Client;
  status: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'AUTHENTICATING' | 'CONNECTED' | 'FAILED';
  qrCode?: string;
  phoneNumber?: string;
}

export interface SendMessageParams {
  accountId: string;
  to: string;
  message: string;
}

export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}
