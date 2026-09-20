-- DropIndex
DROP INDEX "AlertEvent_connectionId_idx";

-- DropIndex
DROP INDEX "AlertEvent_ruleId_firedAt_idx";

-- DropIndex
DROP INDEX "AlertRule_connectionId_idx";

-- DropIndex
DROP INDEX "AlertRule_profileId_idx";

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "dbType" TEXT NOT NULL DEFAULT 'mongodb',
ADD COLUMN     "dbVersion" TEXT,
ADD COLUMN     "metadata" JSONB;
