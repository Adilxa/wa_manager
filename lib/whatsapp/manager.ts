import { Client, LocalAuth } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { prisma } from '@/lib/prisma';
import { WhatsAppClientInfo, SendMessageParams, SendMessageResult } from './types';
import { AccountStatus } from '@prisma/client';

class WhatsAppManager {
  private clients: Map<string, WhatsAppClientInfo> = new Map();

  /**
   * Создает новый WhatsApp аккаунт
   */
  async createAccount(name: string): Promise<string> {
    const account = await prisma.whatsAppAccount.create({
      data: {
        name,
        status: 'DISCONNECTED',
      },
    });

    return account.id;
  }

  /**
   * Получает список всех аккаунтов
   */
  async getAccounts() {
    return await prisma.whatsAppAccount.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Получает информацию об аккаунте
   */
  async getAccount(accountId: string) {
    return await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });
  }

  /**
   * Инициализирует WhatsApp клиент для аккаунта
   */
  async initializeClient(accountId: string): Promise<void> {
    // Проверяем, не подключен ли уже клиент
    if (this.clients.has(accountId)) {
      const existingClient = this.clients.get(accountId)!;
      if (existingClient.status === 'CONNECTED' || existingClient.status === 'CONNECTING') {
        throw new Error('Client is already initialized');
      }
    }

    const account = await prisma.whatsAppAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new Error('Account not found');
    }

    // Создаем новый клиент с уникальной сессией
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: accountId,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    const clientInfo: WhatsAppClientInfo = {
      accountId,
      client,
      status: 'CONNECTING',
    };

    this.clients.set(accountId, clientInfo);

    // Обновляем статус в БД
    await this.updateAccountStatus(accountId, 'CONNECTING');

    // Настраиваем обработчики событий
    this.setupClientHandlers(accountId, client);

    // Инициализируем клиент
    try {
      await client.initialize();
    } catch (error) {
      console.error(`Failed to initialize client for ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'FAILED');
      this.clients.delete(accountId);
      throw error;
    }
  }

  /**
   * Настраивает обработчики событий клиента
   */
  private setupClientHandlers(accountId: string, client: Client): void {
    // QR код получен
    client.on('qr', async (qr: string) => {
      console.log(`QR Code received for ${accountId}`);

      try {
        // Генерируем QR код в виде Data URL
        const qrDataUrl = await QRCode.toDataURL(qr);

        // Обновляем информацию о клиенте
        const clientInfo = this.clients.get(accountId);
        if (clientInfo) {
          clientInfo.qrCode = qrDataUrl;
          clientInfo.status = 'QR_READY';
        }

        // Сохраняем в БД
        await prisma.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            status: 'QR_READY',
            qrCode: qrDataUrl,
          },
        });
      } catch (error) {
        console.error(`Failed to generate QR code for ${accountId}:`, error);
      }
    });

    // Аутентификация успешна
    client.on('authenticated', async () => {
      console.log(`Client authenticated for ${accountId}`);
      await this.updateAccountStatus(accountId, 'AUTHENTICATING');

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.status = 'AUTHENTICATING';
      }
    });

    // Клиент готов к работе
    client.on('ready', async () => {
      console.log(`Client ready for ${accountId}`);

      try {
        // Получаем номер телефона
        const info = client.info;
        const phoneNumber = info?.wid?.user || null;

        // Обновляем информацию о клиенте
        const clientInfo = this.clients.get(accountId);
        if (clientInfo) {
          clientInfo.status = 'CONNECTED';
          clientInfo.phoneNumber = phoneNumber || undefined;
          clientInfo.qrCode = undefined; // Очищаем QR код
        }

        // Сохраняем в БД
        await prisma.whatsAppAccount.update({
          where: { id: accountId },
          data: {
            status: 'CONNECTED',
            phoneNumber: phoneNumber,
            qrCode: null, // Очищаем QR код
          },
        });
      } catch (error) {
        console.error(`Failed to update account info for ${accountId}:`, error);
      }
    });

    // Ошибка аутентификации
    client.on('auth_failure', async (msg: string) => {
      console.error(`Authentication failed for ${accountId}:`, msg);
      await this.updateAccountStatus(accountId, 'FAILED');

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.status = 'FAILED';
      }
    });

    // Отключение
    client.on('disconnected', async (reason: string) => {
      console.log(`Client disconnected for ${accountId}:`, reason);
      await this.updateAccountStatus(accountId, 'DISCONNECTED');

      this.clients.delete(accountId);
    });
  }

  /**
   * Отправляет сообщение через указанный аккаунт
   */
  async sendMessage({ accountId, to, message }: SendMessageParams): Promise<SendMessageResult> {
    const clientInfo = this.clients.get(accountId);

    if (!clientInfo) {
      return {
        success: false,
        error: 'Client not initialized. Please connect the account first.',
      };
    }

    if (clientInfo.status !== 'CONNECTED') {
      return {
        success: false,
        error: `Client is not connected. Current status: ${clientInfo.status}`,
      };
    }

    try {
      // Форматируем номер телефона
      const chatId = to.includes('@c.us') ? to : `${to}@c.us`;

      // Отправляем сообщение
      const sentMessage = await clientInfo.client.sendMessage(chatId, message);

      // Сохраняем в БД
      const messageRecord = await prisma.message.create({
        data: {
          accountId,
          to,
          message,
          status: 'SENT',
        },
      });

      return {
        success: true,
        messageId: sentMessage.id.id,
      };
    } catch (error: any) {
      console.error(`Failed to send message from ${accountId}:`, error);

      // Сохраняем неудачную попытку в БД
      await prisma.message.create({
        data: {
          accountId,
          to,
          message,
          status: 'FAILED',
        },
      });

      return {
        success: false,
        error: error.message || 'Failed to send message',
      };
    }
  }

  /**
   * Получает статус клиента
   */
  getClientStatus(accountId: string): WhatsAppClientInfo | null {
    return this.clients.get(accountId) || null;
  }

  /**
   * Отключает клиент
   */
  async disconnectClient(accountId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);

    if (!clientInfo) {
      throw new Error('Client not found');
    }

    try {
      await clientInfo.client.destroy();
    } catch (error) {
      console.error(`Failed to destroy client for ${accountId}:`, error);
    }

    this.clients.delete(accountId);
    await this.updateAccountStatus(accountId, 'DISCONNECTED');
  }

  /**
   * Удаляет аккаунт
   */
  async deleteAccount(accountId: string): Promise<void> {
    // Сначала отключаем клиент, если он подключен
    if (this.clients.has(accountId)) {
      await this.disconnectClient(accountId);
    }

    // Удаляем из БД (сообщения удалятся автоматически из-за CASCADE)
    await prisma.whatsAppAccount.delete({
      where: { id: accountId },
    });
  }

  /**
   * Обновляет статус аккаунта в БД
   */
  private async updateAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
    try {
      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: { status },
      });
    } catch (error) {
      console.error(`Failed to update status for ${accountId}:`, error);
    }
  }

  /**
   * Получает историю сообщений аккаунта
   */
  async getMessages(accountId: string, limit: number = 50) {
    return await prisma.message.findMany({
      where: { accountId },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Восстанавливает все подключенные клиенты при перезапуске сервера
   */
  async restoreClients(): Promise<void> {
    const connectedAccounts = await prisma.whatsAppAccount.findMany({
      where: {
        status: {
          in: ['CONNECTED', 'QR_READY', 'CONNECTING', 'AUTHENTICATING'],
        },
      },
    });

    console.log(`Restoring ${connectedAccounts.length} clients...`);

    for (const account of connectedAccounts) {
      try {
        await this.initializeClient(account.id);
      } catch (error) {
        console.error(`Failed to restore client for ${account.id}:`, error);
      }
    }
  }
}

// Singleton instance
export const whatsappManager = new WhatsAppManager();
