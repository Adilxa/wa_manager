const { Worker } = require("bullmq");
const prisma = require("./db");
const { CONFIG } = require("./config");
const { redisConfig, contractQueue, getSendQueue, sendQueueName } = require("./queue");
const {
  getAccountSettings,
  checkDailyLimit,
  incrementDailyCount,
  msUntilAllowed,
  registerSend,
} = require("./limits");
const { isLidJid, jidUser, resolveSendRecipient } = require("./jid-resolver");

// Shared state passed from server/index.js
let clients = null;
let logger = console;
let sendMessageWithHumanBehavior = null;

// Contract messages get a lower priority than single/chat messages.
// In BullMQ, jobs without priority are always taken before prioritized ones.
const CONTRACT_PRIORITY = 10;

let contractWorker = null;
const sendWorkers = new Map();

function recipientJobId(recipientId) {
  return `r_${recipientId}`;
}

function isRateLimitError(error) {
  return error && error.message === Worker.RateLimitError().message;
}

// Puts the job back to "waiting" and stops this account's worker from fetching for `ms`.
// Unlike sleep() inside a job, this holds no lock, no worker slot and does not burn an attempt.
async function deferAccount(accountId, ms) {
  await getSendQueue(accountId).rateLimit(Math.max(1000, Math.ceil(ms)));
  throw Worker.RateLimitError();
}

// Marks the contract COMPLETED once every recipient reached a final state
async function completeContractIfDone(contract) {
  if (contract.successCount + contract.failureCount < contract.totalCount) return;

  const { count } = await prisma.contract.updateMany({
    where: { id: contract.id, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  if (count > 0) {
    logger.info(
      `🎉 CONTRACT COMPLETED: ${contract.id} (✅ ${contract.successCount} / ❌ ${contract.failureCount})`
    );
  }
}

async function finalizeRecipientFailure(contractId, recipientId, errorMessage) {
  const [, contract] = await prisma.$transaction([
    prisma.contractRecipient.update({
      where: { id: recipientId },
      data: { status: "FAILED", errorMessage: String(errorMessage).substring(0, 500) },
    }),
    prisma.contract.update({
      where: { id: contractId },
      data: { failureCount: { increment: 1 }, pendingCount: { decrement: 1 } },
      select: { id: true, successCount: true, failureCount: true, totalCount: true },
    }),
  ]);
  await completeContractIfDone(contract);
}

// ==================== CONTRACT WORKER ====================
// Fans a contract's recipients out to the account's send queue in batches,
// so a big contract never loads everything into memory at once.

async function processContractJob(job) {
  const { contractId } = job.data;

  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { id: true, name: true, accountId: true, status: true },
  });

  if (!contract) {
    logger.warn(`Contract ${contractId} not found, skipping`);
    return { skipped: true };
  }

  if (contract.status !== "IN_PROGRESS") {
    logger.info(`Contract ${contractId} is ${contract.status}, not enqueuing`);
    return { skipped: true };
  }

  const queue = getSendQueue(contract.accountId);
  ensureSendWorker(contract.accountId);

  let cursor = null;
  let queued = 0;

  for (;;) {
    // Re-check between batches so a pause stops the fan-out quickly
    const current = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { status: true },
    });
    if (!current || current.status !== "IN_PROGRESS") break;

    // QUEUED is included so a crash between the status update and addBulk can be recovered;
    // jobIds are deterministic, so recipients that already have a job are not duplicated.
    const batch = await prisma.contractRecipient.findMany({
      where: { contractId, status: { in: ["PENDING", "QUEUED"] } },
      select: { id: true, phoneNumber: true, message: true },
      orderBy: { id: "asc" },
      take: CONFIG.CONTRACT_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    await prisma.contractRecipient.updateMany({
      where: { id: { in: batch.map(r => r.id) }, status: "PENDING" },
      data: { status: "QUEUED" },
    });

    await queue.addBulk(
      batch.map(r => ({
        name: "contract",
        data: {
          accountId: contract.accountId,
          contractId,
          recipientId: r.id,
          phoneNumber: r.phoneNumber,
          message: r.message,
        },
        opts: { jobId: recipientJobId(r.id), priority: CONTRACT_PRIORITY },
      }))
    );

    queued += batch.length;
    await job.updateProgress({ queued });
  }

  logger.info(`✅ Enqueued ${queued} messages for contract ${contract.name} (${contractId})`);
  return { success: true, contractId, messagesQueued: queued };
}

function startContractWorker() {
  contractWorker = new Worker("contracts", processContractJob, {
    connection: redisConfig,
    concurrency: 5,
  });

  contractWorker.on("failed", (job, err) => {
    logger.error(`❌ Contract job failed: ${job?.id}: ${err.message}`);
  });

  contractWorker.on("error", err => {
    logger.error(`Contract worker error: ${err.message}`);
  });
}

// ==================== SEND WORKER (one per account) ====================

async function processSendJob(job) {
  const { accountId, contractId, recipientId, phoneNumber, message } = job.data;

  // 1. Contract / recipient state (one query). Handles pause, deletes and re-delivered jobs.
  if (recipientId) {
    const recipient = await prisma.contractRecipient.findUnique({
      where: { id: recipientId },
      select: { status: true, contract: { select: { status: true } } },
    });

    if (!recipient) return { skipped: "recipient deleted" };

    if (recipient.status === "SUCCESS" || recipient.status === "FAILED") {
      return { skipped: `already ${recipient.status}` };
    }

    if (recipient.status === "SENDING") {
      // A previous run died mid-send: the message may already be delivered. Never resend blindly.
      await finalizeRecipientFailure(
        contractId,
        recipientId,
        "Interrupted while sending (not retried to avoid a duplicate)"
      );
      return { skipped: "interrupted" };
    }

    if (recipient.contract.status !== "IN_PROGRESS") {
      await prisma.contractRecipient.updateMany({
        where: { id: recipientId, status: "QUEUED" },
        data: { status: "PENDING" },
      });
      return { skipped: `contract ${recipient.contract.status}` };
    }
  }

  // 2. Account must be connected — otherwise wait for it instead of failing the message
  const clientInfo = clients.get(accountId);
  if (!clientInfo || clientInfo.status !== "CONNECTED") {
    logger.debug(`Account ${accountId} not connected, deferring send queue`);
    await deferAccount(accountId, CONFIG.NOT_CONNECTED_RETRY_DELAY);
  }

  const account = await getAccountSettings(accountId);
  if (!account) {
    throw new Error("Account not found");
  }

  // 3. Daily limit — the queue simply resumes the next day
  const dailyCheck = await checkDailyLimit(accountId);
  if (!dailyCheck.allowed && !dailyCheck.noLimits) {
    logger.warn(
      `🚫 ${dailyCheck.reason} for ${accountId}, resuming in ${Math.round(
        dailyCheck.retryIn / 60000
      )} min`
    );
    await deferAccount(accountId, dailyCheck.retryIn);
  }

  // 4. Pacing (between-message delay, rest periods, per-minute cap)
  const wait = msUntilAllowed(accountId, account);
  if (wait > 0) {
    await deferAccount(accountId, wait);
  }

  // 5. Resolve LID / phone number to the delivery JID
  const destination = resolveSendRecipient(accountId, phoneNumber);
  const jid = destination.deliveryJid;
  const chatId = job.data.chatId || destination.chatId || jid;
  const contactNumber = job.data.contactNumber || destination.contactNumber || jidUser(chatId);

  if (!jid) {
    if (recipientId) {
      await finalizeRecipientFailure(contractId, recipientId, "Invalid recipient JID");
    }
    return { skipped: "invalid recipient" };
  }

  if (destination.resolvedFromLid) {
    logger.info(`🔁 Resolved ${destination.originalJid} -> ${jid}`);
  } else if (isLidJid(jid)) {
    logger.warn(`⚠️ Sending to unresolved LID ${jid}`);
  }

  if (recipientId) {
    await prisma.contractRecipient.update({
      where: { id: recipientId },
      data: { status: "SENDING", attempts: { increment: 1 }, lastAttempt: new Date() },
    });
  }

  let sent;
  try {
    logger.info(
      `📤 Sending to ${contactNumber} from ${accountId}${contractId ? ` (contract ${contractId})` : ""}`
    );
    sent = await sendMessageWithHumanBehavior(accountId, jid, message);
  } catch (error) {
    if (error.message === "Client not connected") {
      // Dropped while typing — nothing was sent, wait for the reconnect without using an attempt
      if (recipientId) {
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: { status: "QUEUED" },
        });
      }
      await deferAccount(accountId, CONFIG.NOT_CONNECTED_RETRY_DELAY);
    }

    const isFinal = job.attemptsMade + 1 >= (job.opts.attempts || 1);
    logger.error(
      `❌ Send failed to ${contactNumber} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}): ${error.message}`
    );

    if (recipientId) {
      if (isFinal) {
        await finalizeRecipientFailure(contractId, recipientId, error.message);
      } else {
        await prisma.contractRecipient.update({
          where: { id: recipientId },
          data: { status: "QUEUED", errorMessage: String(error.message).substring(0, 500) },
        });
      }
    } else if (isFinal) {
      await prisma.message.create({
        data: {
          accountId,
          chatId,
          direction: "OUTGOING",
          message,
          to: contactNumber,
          status: "FAILED",
          contactNumber,
        },
      });
    }

    throw error;
  }

  // The message is out. From here on nothing may throw back into BullMQ,
  // otherwise a retry would send it a second time.
  const { delay, resting } = registerSend(accountId, account);
  if (delay > 0) {
    await getSendQueue(accountId)
      .rateLimit(delay)
      .catch(err => logger.error(`Failed to set pacing for ${accountId}: ${err.message}`));
    if (resting) {
      logger.info(`💤 Account ${accountId} resting for ${Math.round(delay / 1000)}s`);
    }
  }

  try {
    await incrementDailyCount(accountId);

    const messageData = {
      accountId,
      chatId,
      direction: "OUTGOING",
      message,
      to: contactNumber,
      status: "SENT",
      contactNumber,
      waMessageId: sent?.key?.id || null,
    };

    if (recipientId) {
      const [dbMessage, contract] = await prisma.$transaction(async tx => {
        const created = await tx.message.create({ data: messageData });
        await tx.contractRecipient.update({
          where: { id: recipientId },
          data: { status: "SUCCESS", messageId: created.id, sentAt: new Date(), errorMessage: null },
        });
        const updated = await tx.contract.update({
          where: { id: contractId },
          data: { successCount: { increment: 1 }, pendingCount: { decrement: 1 } },
          select: { id: true, successCount: true, failureCount: true, totalCount: true },
        });
        return [created, updated];
      });
      await completeContractIfDone(contract);
      logger.info(`✅ SUCCESS: ${contactNumber} (message ${dbMessage.id})`);
    } else {
      const dbMessage = await prisma.message.create({ data: messageData });
      if (global.io) {
        global.io.of("/chats").to(`account:${accountId}`).emit("chat:message:new", {
          accountId,
          chatId,
          message: dbMessage,
        });
      }
      logger.info(`✅ SUCCESS: ${contactNumber}`);
    }
  } catch (error) {
    logger.error(`Message to ${contactNumber} was sent but bookkeeping failed: ${error.message}`);
  }

  return { success: true, phoneNumber, contractId };
}

function ensureSendWorker(accountId) {
  if (sendWorkers.has(accountId)) return sendWorkers.get(accountId);

  const worker = new Worker(sendQueueName(accountId), processSendJob, {
    connection: redisConfig,
    // Strictly one message at a time per account; accounts run in parallel with each other
    concurrency: 1,
    // Covers typing simulation (≤ ~8s) plus a slow sendMessage (30s query timeout)
    lockDuration: 120000,
    // Required for manual rate limiting (queue.rateLimit) to take effect; never reached by itself
    limiter: { max: 1000000, duration: 1000 },
  });

  worker.on("failed", (job, err) => {
    if (!isRateLimitError(err)) {
      logger.warn(`Send job ${job?.id} for ${accountId} failed: ${err.message}`);
    }
  });

  worker.on("error", err => {
    logger.error(`Send worker error for ${accountId}: ${err.message}`);
  });

  sendWorkers.set(accountId, worker);
  return worker;
}

async function stopSendWorker(accountId) {
  const worker = sendWorkers.get(accountId);
  if (!worker) return;
  sendWorkers.delete(accountId);
  await worker.close();
}

// ==================== LIFECYCLE ====================

async function initializeWorkers(dependencies) {
  clients = dependencies.clients;
  logger = dependencies.logger;
  sendMessageWithHumanBehavior = dependencies.sendMessageWithHumanBehavior;

  startContractWorker();

  // Every account gets a worker so messages queued before a restart keep flowing
  const accounts = await prisma.whatsAppAccount.findMany({ select: { id: true } });
  for (const { id } of accounts) {
    ensureSendWorker(id);
  }

  logger.info(`✅ BullMQ workers initialized (${accounts.length} account send worker(s))`);
}

async function closeWorkers() {
  await Promise.allSettled([
    contractWorker?.close(),
    ...Array.from(sendWorkers.values()).map(w => w.close()),
  ]);
  sendWorkers.clear();
}

// ==================== ENQUEUE HELPERS ====================

async function enqueueContract(contractId) {
  return contractQueue.add(
    "contract",
    { contractId },
    // Dedup: a second start while the fan-out is still running is a no-op
    { jobId: `contract_${contractId}` }
  );
}

// Single-recipient contract message (POST /api/messages/send) — jumps ahead of broadcasts
async function enqueueRecipient(accountId, contractId, recipient) {
  ensureSendWorker(accountId);
  return getSendQueue(accountId).add(
    "single",
    {
      accountId,
      contractId,
      recipientId: recipient.id,
      phoneNumber: recipient.phoneNumber,
      message: recipient.message,
    },
    { jobId: recipientJobId(recipient.id) }
  );
}

// Chat message without a contract — jumps ahead of broadcasts
async function enqueueDirectMessage(accountId, to, message, metadata = {}) {
  ensureSendWorker(accountId);
  return getSendQueue(accountId).add("direct", {
    accountId,
    phoneNumber: to,
    message,
    chatId: metadata.chatId || null,
    contactNumber: metadata.contactNumber || null,
  });
}

async function getSendQueueInfo(accountId) {
  const queue = getSendQueue(accountId);
  const [counts, jobs] = await Promise.all([
    queue.getJobCounts("waiting", "prioritized", "active", "delayed", "failed"),
    queue.getJobs(["active", "waiting", "prioritized"], 0, 19, true),
  ]);
  const pending = counts.waiting + counts.prioritized + counts.delayed;
  return {
    counts: { ...counts, pending },
    queueLength: pending + counts.active,
    messages: jobs.filter(Boolean).map((job, index) => ({
      position: index + 1,
      to: job.data.phoneNumber,
      contractId: job.data.contractId || null,
      message: job.data.message.substring(0, 50) + (job.data.message.length > 50 ? "..." : ""),
      retries: job.attemptsMade,
      createdAt: new Date(job.timestamp).toISOString(),
    })),
  };
}

module.exports = {
  initializeWorkers,
  closeWorkers,
  ensureSendWorker,
  stopSendWorker,
  enqueueContract,
  enqueueRecipient,
  enqueueDirectMessage,
  getSendQueueInfo,
};
