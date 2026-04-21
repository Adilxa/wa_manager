const TelegramBot = require("node-telegram-bot-api");

class TelegramNotifier {
  constructor(logger) {
    this.logger = logger;
    this.bot = null;
    this.chatIds = this.parseChatIds(process.env.TELEGRAM_CHAT_ID);
    this.enabled = false;

    this.initialize();
  }

  parseChatIds(chatIds) {
    return String(chatIds || "")
      .split(/[,\s;]+/)
      .map(chatId => chatId.trim())
      .filter(Boolean);
  }

  maskChatId(chatId) {
    if (chatId.length <= 4) {
      return chatId;
    }

    return `${chatId.slice(0, 3)}...${chatId.slice(-4)}`;
  }

  serializeTelegramError(error) {
    const err = error || {};

    return {
      message: err.message || String(error),
      code: err.code,
      statusCode: err.response?.statusCode,
      response: err.response?.body,
    };
  }

  shouldRetryWithoutParseMode(error) {
    const description =
      error.response?.body?.description || error.message || "";

    return (
      description.includes("can't parse entities") ||
      description.includes("can't parse message text")
    );
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token || this.chatIds.length === 0) {
      this.logger.warn(
        {
          token: token ? "present" : "missing",
          chatIdCount: this.chatIds.length,
        },
        "Telegram bot credentials not found. Notifications disabled."
      );
      return;
    }

    try {
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
      this.logger.info(
        {
          chatCount: this.chatIds.length,
          chatIds: this.chatIds.map(chatId => this.maskChatId(chatId)),
          tokenLength: token.length,
        },
        "✅ Telegram bot initialized successfully"
      );

      // Send startup notification with a small delay to ensure bot is ready
      setTimeout(() => {
        this.sendNotification(
          "🚀 *WhatsApp Manager Started*\n\n" +
          `Server is now running\n` +
          `Time: ${new Date().toLocaleString()}`
        );
      }, 1000);
    } catch (error) {
      this.logger.error(
        { err: this.serializeTelegramError(error) },
        "Failed to initialize Telegram bot"
      );
      this.enabled = false;
    }
  }

  async sendMessageToChat(chatId, message, parseMode) {
    try {
      return await this.bot.sendMessage(chatId, message, {
        parse_mode: parseMode,
      });
    } catch (error) {
      if (parseMode && this.shouldRetryWithoutParseMode(error)) {
        this.logger.warn(
          {
            chatId: this.maskChatId(chatId),
            err: this.serializeTelegramError(error),
          },
          "Retrying Telegram notification without parse mode"
        );

        return this.bot.sendMessage(chatId, message);
      }

      throw error;
    }
  }

  async sendNotification(message, parseMode = "Markdown") {
    if (!this.enabled || !this.bot) {
      this.logger.debug("Telegram notifications disabled, skipping message");
      return;
    }

    const results = await Promise.allSettled(
      this.chatIds.map(chatId =>
        this.sendMessageToChat(chatId, message, parseMode)
      )
    );

    const failures = results
      .map((result, index) => ({ result, chatId: this.chatIds[index] }))
      .filter(({ result }) => result.status === "rejected")
      .map(({ result, chatId }) => ({
        chatId: this.maskChatId(chatId),
        err: this.serializeTelegramError(result.reason),
      }));

    const sentCount = results.length - failures.length;

    if (sentCount > 0) {
      this.logger.debug(
        { sentCount, totalCount: this.chatIds.length },
        "Telegram notification sent"
      );
    }

    if (failures.length > 0) {
      this.logger.error(
        { failures, sentCount, totalCount: this.chatIds.length },
        "Failed to send Telegram notification"
      );
    }
  }

  // Account notifications
  async notifyAccountConnected(accountId, accountName, phoneNumber) {
    const message =
      `✅ *Account Connected*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Phone: ${phoneNumber || "Unknown"}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyAccountDisconnected(accountId, accountName, reason = "Manual disconnect") {
    const message =
      `⚠️ *Account Disconnected*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Reason: ${reason}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyAccountFailed(accountId, accountName, error) {
    const message =
      `❌ *Account Connection Failed*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Error: ${error}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  // Contract notifications
  async notifyContractStarted(contractId, contractName, totalRecipients) {
    const message =
      `📋 *Contract Started*\n\n` +
      `Name: ${contractName}\n` +
      `ID: \`${contractId}\`\n` +
      `Recipients: ${totalRecipients}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyContractCompleted(contractId, contractName, stats) {
    const successRate = stats.total > 0
      ? ((stats.success / stats.total) * 100).toFixed(1)
      : 0;

    const message =
      `✅ *Contract Completed*\n\n` +
      `Name: ${contractName}\n` +
      `ID: \`${contractId}\`\n\n` +
      `📊 *Statistics:*\n` +
      `Total: ${stats.total}\n` +
      `✅ Success: ${stats.success}\n` +
      `❌ Failed: ${stats.failed}\n` +
      `📈 Success Rate: ${successRate}%\n\n` +
      `Duration: ${stats.duration || "N/A"}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyContractPaused(contractId, contractName, stats) {
    const message =
      `⏸️ *Contract Paused*\n\n` +
      `Name: ${contractName}\n` +
      `ID: \`${contractId}\`\n\n` +
      `Progress: ${stats.success}/${stats.total}\n` +
      `Pending: ${stats.pending}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  // Queue notifications
  async notifyQueueStatus(accountId, accountName, queueStats) {
    const message =
      `📊 *Queue Status Update*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n\n` +
      `Queue Length: ${queueStats.length}\n` +
      `Daily Count: ${queueStats.dailyCount}/${queueStats.dailyLimit}\n` +
      `Status: ${queueStats.status}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  // Error notifications
  async notifyError(title, error, context = {}) {
    let contextStr = "";
    if (Object.keys(context).length > 0) {
      contextStr = "\n\n*Context:*\n";
      for (const [key, value] of Object.entries(context)) {
        contextStr += `${key}: ${value}\n`;
      }
    }

    const message =
      `🔴 *Error: ${title}*\n\n` +
      `Message: ${error.message || error}\n` +
      contextStr +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  // System notifications
  async notifySystemStatus(stats) {
    const message =
      `📊 *System Status*\n\n` +
      `Active Clients: ${stats.activeClients}\n` +
      `Connecting Clients: ${stats.connectingClients ?? 0}\n` +
      `Reconnect Attempts: ${stats.reconnectAttempts ?? 0}\n` +
      `Memory Used: ${stats.memoryUsedMB}MB / ${stats.memoryTotalMB}MB (${stats.memoryPercent}%)\n` +
      `RSS: ${stats.rssMB ?? "N/A"}MB\n` +
      `Uptime: ${stats.uptimeFormatted}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyMemoryAlert(level, stats) {
    const isCritical = level === "critical";
    const message =
      `${isCritical ? "🔴" : "🟠"} *${isCritical ? "Critical Memory Alert" : "Memory Warning"}*\n\n` +
      `Memory Used: ${stats.memoryUsedMB}MB / ${stats.memoryTotalMB}MB (${stats.memoryPercent}%)\n` +
      `RSS: ${stats.rssMB}MB\n` +
      `Active Clients: ${stats.activeClients}\n` +
      `Connecting Clients: ${stats.connectingClients}\n` +
      `Uptime: ${stats.uptimeFormatted}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyHeartbeatFailed(accountId, accountName, error) {
    const message =
      `💓 *WhatsApp Heartbeat Failed*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Error: ${error}\n` +
      `Action: Reconnecting\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyDailyLimitReached(accountId, accountName, limit) {
    const message =
      `⚠️ *Daily Limit Reached*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Limit: ${limit} messages\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  async notifyRateLimitReached(accountId, accountName, resetIn) {
    const message =
      `⏱️ *Rate Limit Reached*\n\n` +
      `Account: ${accountName}\n` +
      `ID: \`${accountId}\`\n` +
      `Reset in: ${resetIn} seconds\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }

  // Server shutdown notification
  async notifyShutdown(reason = "Manual shutdown") {
    const message =
      `🛑 *Server Shutting Down*\n\n` +
      `Reason: ${reason}\n` +
      `Time: ${new Date().toLocaleString()}`;

    await this.sendNotification(message);
  }
}

module.exports = TelegramNotifier;
