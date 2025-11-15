-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- AlterTable: Drop old sessionData column from whatsapp_accounts
ALTER TABLE "whatsapp_accounts" DROP COLUMN IF EXISTS "sessionData";

-- AlterTable: Update messages table structure
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_accountId_fkey";

-- Drop old table and recreate with new structure
DROP TABLE IF EXISTS "messages";

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" TEXT,
    "direction" "MessageDirection",
    "message" TEXT NOT NULL,
    "to" TEXT,
    "from" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "contactName" TEXT,
    "contactNumber" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_accountId_idx" ON "messages"("accountId");

-- CreateIndex
CREATE INDEX "messages_accountId_chatId_idx" ON "messages"("accountId", "chatId");

-- CreateIndex
CREATE INDEX "messages_status_idx" ON "messages"("status");

-- CreateIndex
CREATE INDEX "messages_sentAt_idx" ON "messages"("sentAt");

-- CreateIndex
CREATE INDEX "messages_to_idx" ON "messages"("to");

-- CreateIndex
CREATE INDEX "messages_from_idx" ON "messages"("from");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
