-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'QR_READY', 'AUTHENTICATING', 'CONNECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "qrCode" TEXT,
    "sessionData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_phoneNumber_key" ON "whatsapp_accounts"("phoneNumber");

-- CreateIndex
CREATE INDEX "whatsapp_accounts_status_idx" ON "whatsapp_accounts"("status");

-- CreateIndex
CREATE INDEX "messages_accountId_idx" ON "messages"("accountId");

-- CreateIndex
CREATE INDEX "messages_status_idx" ON "messages"("status");

-- CreateIndex
CREATE INDEX "messages_sentAt_idx" ON "messages"("sentAt");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
