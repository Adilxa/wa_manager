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
          '--disable-session-crashed-bubble',
          '--disable-features=ProcessPerSiteUpToMainFrameThreshold',
          '--disable-crash-reporter',
          '--no-crash-upload',
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

    // Инициализируем клиент в фоне (не блокируем)
    client.initialize().catch(async (error) => {
      console.error(`Failed to initialize client for ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'FAILED');
      this.clients.delete(accountId);
    });

    // Возвращаем сразу, не дожидаясь инициализации
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

    // Входящие сообщения
    client.on('message', async (msg: any) => {
      try {
        console.log(`Message received for ${accountId} from ${msg.from}`);

        // Получаем информацию о контакте
        const contact = await msg.getContact();
        const chat = await msg.getChat();

        // Извлекаем номер телефона без @c.us
        const contactNumber = msg.from.replace('@c.us', '').replace('@g.us', '');

        // Сохраняем входящее сообщение в БД
        await prisma.message.create({
          data: {
            accountId,
            whatsappMessageId: msg.id.id,
            direction: 'INCOMING',
            chatId: msg.from,
            contactNumber: contactNumber,
            contactName: contact.pushname || contact.name || contactNumber,
            message: msg.body,
            status: 'DELIVERED',
            timestamp: msg.timestamp ? BigInt(msg.timestamp) : null,
          },
        });

        console.log(`Message saved: ${msg.body.substring(0, 50)}...`);
      } catch (error) {
        console.error(`Failed to save incoming message for ${accountId}:`, error);
      }
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
      const contactNumber = to.replace('@c.us', '').replace('@g.us', '');

      // Отправляем сообщение
      const sentMessage = await clientInfo.client.sendMessage(chatId, message);

      // Получаем информацию о контакте
      let contactName = contactNumber;
      try {
        const contact = await clientInfo.client.getContactById(chatId);
        contactName = contact.pushname || contact.name || contactNumber;
      } catch (e) {
        console.log('Could not get contact name, using number');
      }

      // Сохраняем в БД
      const messageRecord = await prisma.message.create({
        data: {
          accountId,
          whatsappMessageId: sentMessage.id.id,
          direction: 'OUTGOING',
          chatId,
          contactNumber,
          contactName,
          message,
          status: 'SENT',
          timestamp: sentMessage.timestamp ? BigInt(sentMessage.timestamp) : null,
        },
      });

      return {
        success: true,
        messageId: sentMessage.id.id,
      };
    } catch (error: any) {
      console.error(`Failed to send message from ${accountId}:`, error);

      // Сохраняем неудачную попытку в БД
      const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
      const contactNumber = to.replace('@c.us', '').replace('@g.us', '');

      await prisma.message.create({
        data: {
          accountId,
          direction: 'OUTGOING',
          chatId,
          contactNumber,
          contactName: contactNumber,
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
   * Получает список чатов аккаунта
   */
  async getChats(accountId: string) {
    // Получаем последнее сообщение из каждого чата
    const messages = await prisma.message.findMany({
      where: { accountId },
      orderBy: { sentAt: 'desc' },
      distinct: ['chatId'],
    });

    // Группируем по chatId и получаем информацию о каждом чате
    const chats = await Promise.all(
      messages.map(async (msg) => {
        // Подсчитываем количество непрочитанных сообщений (входящих со статусом DELIVERED)
        const unreadCount = await prisma.message.count({
          where: {
            accountId,
            chatId: msg.chatId,
            direction: 'INCOMING',
            status: 'DELIVERED',
          },
        });

        // Получаем последнее сообщение
        const lastMessage = await prisma.message.findFirst({
          where: {
            accountId,
            chatId: msg.chatId,
          },
          orderBy: { sentAt: 'desc' },
        });

        return {
          chatId: msg.chatId,
          contactNumber: msg.contactNumber,
          contactName: msg.contactName || msg.contactNumber,
          lastMessage: lastMessage?.message || '',
          lastMessageTime: lastMessage?.sentAt || new Date(),
          unreadCount,
          direction: lastMessage?.direction || 'OUTGOING',
        };
      })
    );

    // Сортируем по времени последнего сообщения
    return chats.sort((a, b) => b.lastMessageTime.getTime() - a.lastMessageTime.getTime());
  }

  /**
   * Получает сообщения конкретного чата
   */
  async getChatMessages(accountId: string, chatId: string, limit: number = 50) {
    const messages = await prisma.message.findMany({
      where: {
        accountId,
        chatId,
      },
      orderBy: { sentAt: 'asc' },
      take: limit,
    });

    // Отмечаем входящие сообщения как прочитанные
    await prisma.message.updateMany({
      where: {
        accountId,
        chatId,
        direction: 'INCOMING',
        status: 'DELIVERED',
      },
      data: {
        status: 'READ',
      },
    });

    return messages;
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
        status: 'CONNECTED',
      },
    });

    if (connectedAccounts.length === 0) {
      console.log('📭 No accounts to restore');
      return;
    }

    console.log(`🔄 Auto-restoring ${connectedAccounts.length} connected account(s)...`);

    for (const account of connectedAccounts) {
      try {
        console.log(`   Restoring: ${account.name} (${account.id})`);
        await this.initializeClient(account.id);
      } catch (error) {
        console.error(`   Failed to restore ${account.name}:`, error);
      }
    }

    console.log(`✅ Auto-restore initiated for ${connectedAccounts.length} account(s)`);
  }
}

// Singleton instance
export const whatsappManager = new WhatsAppManager();
