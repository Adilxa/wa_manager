-- AlterEnum: Add RECEIVED to MessageStatus
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
