/*
  Warnings:

  - You are about to drop the column `enabled` on the `BackupJob` table. All the data in the column will be lost.
  - You are about to drop the column `r2DestId` on the `BackupJob` table. All the data in the column will be lost.
  - You are about to drop the column `retentionPolicy` on the `BackupJob` table. All the data in the column will be lost.
  - You are about to drop the column `scope` on the `BackupJob` table. All the data in the column will be lost.
  - You are about to drop the column `backupJobId` on the `JobRun` table. All the data in the column will be lost.
  - You are about to drop the `R2Destination` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `name` to the `BackupJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `BackupJob` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "BackupJob" DROP CONSTRAINT "BackupJob_profileId_fkey";

-- DropForeignKey
ALTER TABLE "BackupJob" DROP CONSTRAINT "BackupJob_r2DestId_fkey";

-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_backupJobId_fkey";

-- DropForeignKey
ALTER TABLE "R2Destination" DROP CONSTRAINT "R2Destination_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "R2Destination" DROP CONSTRAINT "R2Destination_profileId_fkey";

-- AlterTable
ALTER TABLE "BackupJob" DROP COLUMN "enabled",
DROP COLUMN "r2DestId",
DROP COLUMN "retentionPolicy",
DROP COLUMN "scope",
ADD COLUMN     "databases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastRunError" TEXT,
ADD COLUMN     "lastRunStatus" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "JobRun" DROP COLUMN "backupJobId";

-- DropTable
DROP TABLE "R2Destination";

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sizeBytes" BIGINT,
    "filePath" TEXT,
    "databases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorMsg" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
