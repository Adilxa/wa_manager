const TelegramBot = require("node-telegram-bot-api");

class TelegramNotifier {
  constructor(logger) {
    this.logger = logger;
    this.bot = null;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = false;

    this.initialize();
  }

  initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token || !this.chatId) {
      this.logger.warn(
        "Telegram bot credentials not found. Notifications disabled."
      );
      return;
    }

    try {
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
      this.logger.info("✅ Telegram bot initialized successfully");

      // Send startup notification
      this.sendNotification(
        "🚀 *WhatsApp Manager Started*\n\n" +
        `Server is now running\n` +
        `Time: ${new Date().toLocaleString()}`
      );
    } catch (error) {
      this.logger.error("Failed to initialize Telegram bot:", error);
      this.enabled = false;
    }
  }

  async sendNotification(message, parseMode = "Markdown") {
    if (!this.enabled || !this.bot) {
      this.logger.debug("Telegram notifications disabled, skipping message");
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: parseMode,
      });
      this.logger.debug("Telegram notification sent");
    } catch (error) {
      this.logger.error("Failed to send Telegram notification:", error.message);
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
      `Memory Used: ${stats.memoryUsedMB}MB / ${stats.memoryTotalMB}MB (${stats.memoryPercent}%)\n` +
      `Uptime: ${stats.uptimeFormatted}\n` +
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
