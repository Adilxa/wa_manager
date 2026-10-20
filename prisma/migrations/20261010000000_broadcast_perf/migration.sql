-- Idempotent: production schema is managed with `prisma db push`, so this can also be applied by hand.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "waMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "messages_accountId_waMessageId_key" ON "messages"("accountId", "waMessageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "messages_accountId_sentAt_idx" ON "messages"("accountId", "sentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "contract_recipients_contractId_status_idx" ON "contract_recipients"("contractId", "status");
