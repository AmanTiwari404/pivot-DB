/*
  Warnings:

  - You are about to drop the column `s3DestId` on the `BackupJob` table. All the data in the column will be lost.
  - You are about to drop the `S3Destination` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `profileId` to the `AlertRule` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profileId` to the `BackupJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `r2DestId` to the `BackupJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profileId` to the `Connection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profileId` to the `ExportJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profileId` to the `SavedQuery` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profileId` to the `SyncJob` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "BackupJob" DROP CONSTRAINT "BackupJob_s3DestId_fkey";

-- DropForeignKey
ALTER TABLE "S3Destination" DROP CONSTRAINT "S3Destination_connectionId_fkey";

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "profileId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BackupJob" DROP COLUMN "s3DestId",
ADD COLUMN     "profileId" TEXT NOT NULL,
ADD COLUMN     "r2DestId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "profileId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN     "exportType" TEXT NOT NULL DEFAULT 'collection',
ADD COLUMN     "profileId" TEXT NOT NULL,
ALTER COLUMN "collection" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SavedQuery" ADD COLUMN     "profileId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "SyncJob" ADD COLUMN     "profileId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "invitedBy" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "profileId" TEXT;

-- DropTable
DROP TABLE "S3Destination";

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "R2Destination" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "encryptedAccessKey" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "R2Destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceConnId" TEXT NOT NULL,
    "destConnId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tempDirPath" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "phase" TEXT,
    "dumpSizeBytes" INTEGER,
    "counts" JSONB,
    "errorReport" JSONB,
    "logLines" TEXT[],

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_adminId_key" ON "Profile"("adminId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "R2Destination" ADD CONSTRAINT "R2Destination_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "R2Destination" ADD CONSTRAINT "R2Destination_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_r2DestId_fkey" FOREIGN KEY ("r2DestId") REFERENCES "R2Destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_sourceConnId_fkey" FOREIGN KEY ("sourceConnId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_destConnId_fkey" FOREIGN KEY ("destConnId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "MigrationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedQuery" ADD CONSTRAINT "SavedQuery_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
