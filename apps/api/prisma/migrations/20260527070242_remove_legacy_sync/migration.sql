/*
  Warnings:

  - You are about to drop the column `syncJobId` on the `JobRun` table. All the data in the column will be lost.
  - You are about to drop the `SyncJob` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_syncJobId_fkey";

-- DropForeignKey
ALTER TABLE "SyncJob" DROP CONSTRAINT "SyncJob_destConnId_fkey";

-- DropForeignKey
ALTER TABLE "SyncJob" DROP CONSTRAINT "SyncJob_profileId_fkey";

-- DropForeignKey
ALTER TABLE "SyncJob" DROP CONSTRAINT "SyncJob_sourceConnId_fkey";

-- AlterTable
ALTER TABLE "JobRun" DROP COLUMN "syncJobId";

-- DropTable
DROP TABLE "SyncJob";
