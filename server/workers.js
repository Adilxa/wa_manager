const { Worker } = require("bullmq");
const { PrismaClient } = require("@prisma/client");
const { contractQueue, messageQueue, redisConnection } = require("./queue");

const prisma = new PrismaClient();

// Shared state (you'll pass this from server/index.js)
let clients = null;
let logger = null;
let CONFIG = null;
let checkRateLimit = null;
let checkDailyLimit = null;
let checkNeedRest = null;
let sendMessageWithHumanBehavior = null;
let messageCounters = null;
let dailyLimits = null;

// Initialize workers with dependencies
function initializeWorkers(dependencies) {
  clients = dependencies.clients;
  logger = dependencies.logger;
  CONFIG = dependencies.CONFIG;
  checkRateLimit = dependencies.checkRateLimit;
  checkDailyLimit = dependencies.checkDailyLimit;
  checkNeedRest = dependencies.checkNeedRest;
  sendMessageWithHumanBehavior = dependencies.sendMessageWithHumanBehavior;
  messageCounters = dependencies.messageCounters;
  dailyLimits = dependencies.dailyLimits;

  // Start workers
  startContractWorker();
  startMessageWorker();

  logger.info("✅ BullMQ workers initialized");
}

// Helper functions
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== CONTRACT WORKER ====================
function startContractWorker() {
  const contractWorker = new Worker(
    "contracts",
    async (job) => {
      const { contractId } = job.data;

      logger.info(`🔄 Processing contract job: ${contractId}`);

      try {
        // Get contract from database
        const contract = await prisma.contract.findUnique({
          where: { id: contractId },
          include: {
            recipients: {
              where: { status: { in: ["PENDING", "FAILED"] } },
              orderBy: { createdAt: "asc" },
            },
          },
        });

        if (!contract) {
          throw new Error(`Contract ${contractId} not found`);
        }

        const accountId = contract.accountId;
        const clientInfo = clients.get(accountId);

        if (!clientInfo || clientInfo.status !== "CONNECTED") {
          logger.warn(
            `Client ${accountId} not connected, pausing contract ${contractId}`
          );
          await prisma.contract.update({
            where: { id: contractId },
            data: { status: "PAUSED" },
          });
          throw new Error("Account not connected");
        }

        // Update contract status to IN_PROGRESS
        if (contract.status === "PENDING") {
          await prisma.contract.update({
            where: { id: contractId },
            data: {
              status: "IN_PROGRESS",
              startedAt: new Date(),
            },
          });
        }

        logger.info(
          `📋 Processing contract ${contract.name}: ${contract.recipients.length} recipients`
        );

        // Add all recipients to message queue
        const jobs = [];
        for (const recipient of contract.recipients) {
          jobs.push({
            name: `msg-${recipient.phoneNumber}`,
            data: {
              contractId,
              recipientId: recipient.id,
              accountId,
              phoneNumber: recipient.phoneNumber,
              message: recipient.message,
            },
            opts: {
              priority: 1, // Can add priority if needed
            },
          });
        }

        // Bulk add to message queue
        await messageQueue.addBulk(jobs);

        logger.info(
          `✅ Added ${jobs.length} messages to queue for contract ${contractId}`
        );

        // Update progress
        await job.updateProgress(100);

        return {
          success: true,
          contractId,
          messagesQueued: jobs.length,
        };
      } catch (error) {
        logger.error(`❌ Contract worker error:`, error);

        await prisma.contract.update({
          where: { id: contractId },
          data: { status: "FAILED" },
        });

        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 5, // Process up to 5 contracts simultaneously
      limiter: {
        max: 10,
        duration: 1000, // Max 10 contract jobs per second
      },
    }
  );

  contractWorker.on("completed", (job) => {
    logger.info(`✅ Contract job completed: ${job.id}`);
  });

  contractWorker.on("failed", (job, err) => {
    logger.error(`❌ Contract job failed: ${job?.id}`, err.message);
  });

  return contractWorker;
}

// ==================== MESSAGE WORKER ====================
function startMessageWorker() {
  const messageWorker = new Worker(
    "messages",
    async (job) => {
      const { contractId, recipientId, accountId, phoneNumber, message } =
        job.data;

      try {
        // Update recipient status to QUEUED
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: {
            status: "QUEUED",
            attempts: { increment: 1 },
            lastAttempt: new Date(),
          },
        });

        // Check rate limit
        const rateCheck = await checkRateLimit(accountId);
        if (!rateCheck.allowed && !rateCheck.noLimits) {
          logger.warn(
            `⏳ Rate limit reached for ${accountId}. Delaying ${rateCheck.resetIn}s...`
          );
          await sleep(rateCheck.resetIn * 1000);
        }

        // Check daily limit
        const dailyCheck = await checkDailyLimit(accountId);
        if (!dailyCheck.allowed && !dailyCheck.noLimits) {
          logger.error(
            `🚫 Daily limit reached for ${accountId}: ${dailyCheck.reason}`
          );
          await prisma.contract.update({
            where: { id: contractId },
            data: { status: "PAUSED" },
          });
          throw new Error(`Daily limit reached: ${dailyCheck.reason}`);
        }

        // Check if need rest
        const restCheck = await checkNeedRest(accountId);
        if (restCheck.needRest && !restCheck.noLimits) {
          const counter = messageCounters.get(accountId);
          if (counter && !counter.isResting) {
            counter.isResting = true;
            const restDuration = randomDelay(
              CONFIG.REST_DURATION_MIN,
              CONFIG.REST_DURATION_MAX
            );
            logger.info(
              `💤 Account ${accountId} resting for ${Math.round(
                restDuration / 1000
              )}s after ${counter.count} messages`
            );

            await sleep(restDuration);

            counter.isResting = false;
            counter.count = 0;
            counter.lastRest = Date.now();
            logger.info(`✨ Account ${accountId} resuming after rest...`);
          }
        }

        // Update recipient status to SENDING
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: { status: "SENDING" },
        });

        // Format JID for WhatsApp
        // Support: @lid (group participants), @s.whatsapp.net (regular users), @g.us (groups)
        let jid;
        let cleanPhone = phoneNumber;
        if (phoneNumber.includes("@lid") || phoneNumber.includes("@s.whatsapp.net") || phoneNumber.includes("@g.us")) {
          // Already formatted - use as is
          jid = phoneNumber;
          cleanPhone = phoneNumber.split("@")[0];
        } else {
          // Clean phone number and format as regular user
          cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
          jid = `${cleanPhone}@s.whatsapp.net`;
        }

        logger.info(`📤 Sending to ${cleanPhone} (Contract: ${contractId})`);

        // Send message with human-like behavior
        await sendMessageWithHumanBehavior(accountId, jid, message);

        // Save to database
        const dbMessage = await prisma.message.create({
          data: {
            accountId,
            chatId: jid,
            direction: "OUTGOING",
            message: message,
            to: cleanPhone,
            status: "SENT",
            contactNumber: cleanPhone,
          },
        });

        // Update recipient status to SUCCESS
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: {
            status: "SUCCESS",
            messageId: dbMessage.id,
            sentAt: new Date(),
          },
        });

        // Update contract counters
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            successCount: { increment: 1 },
            pendingCount: { decrement: 1 },
          },
        });

        // Increment daily counter
        const limits = dailyLimits.get(accountId);
        if (limits) {
          limits.messageCount++;
        }

        // Increment message counter for rest periods
        const counter = messageCounters.get(accountId);
        if (counter) {
          counter.count++;
        }

        logger.info(`✅ SUCCESS: ${phoneNumber}`);

        // Check if contract is completed
        const updatedContract = await prisma.contract.findUnique({
          where: { id: contractId },
          include: {
            _count: {
              select: {
                recipients: {
                  where: { status: { in: ["PENDING", "QUEUED", "SENDING"] } },
                },
              },
            },
          },
        });

        if (updatedContract._count.recipients === 0) {
          // Contract completed
          await prisma.contract.update({
            where: { id: contractId },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
            },
          });

          logger.info(`🎉 CONTRACT COMPLETED: ${contractId}`);
          logger.info(`   ✅ Success: ${updatedContract.successCount}`);
          logger.info(`   ❌ Failed: ${updatedContract.failureCount}`);
        }

        // Get account to check if limits should be applied
        const account = await prisma.whatsAppAccount.findUnique({
          where: { id: accountId },
        });

        // Add delay between messages if limits are enabled
        if (account && account.useLimits) {
          const nextDelay = randomDelay(
            CONFIG.DELAY_BETWEEN_MESSAGES_MIN,
            CONFIG.DELAY_BETWEEN_MESSAGES_MAX
          );
          await sleep(nextDelay);
        } else {
          // Small delay even without limits
          await sleep(100);
        }

        await job.updateProgress(100);

        return {
          success: true,
          phoneNumber,
          contractId,
        };
      } catch (error) {
        logger.error(`❌ FAILED: ${phoneNumber} - ${error.message}`);

        // Update recipient status to FAILED
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: {
            status: "FAILED",
            errorMessage: error.message,
          },
        });

        // Update contract counters
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            failureCount: { increment: 1 },
            pendingCount: { decrement: 1 },
          },
        });

        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 1, // Process messages one at a time per account (important!)
      limiter: {
        max: 20, // Max 20 messages per minute (matches CONFIG.RATE_LIMIT_MAX_MESSAGES)
        duration: 60000,
      },
    }
  );

  messageWorker.on("completed", (job) => {
    logger.debug(`✅ Message sent: ${job.data.phoneNumber}`);
  });

  messageWorker.on("failed", (job, err) => {
    logger.error(
      `❌ Message failed: ${job?.data?.phoneNumber}`,
      err.message
    );
  });

  return messageWorker;
}

module.exports = {
  initializeWorkers,
};
