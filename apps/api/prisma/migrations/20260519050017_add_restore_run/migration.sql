-- CreateTable
CREATE TABLE "RestoreRun" (
    "id" TEXT NOT NULL,
    "backupRunId" TEXT NOT NULL,
    "targetConnectionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "log" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestoreRun_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RestoreRun" ADD CONSTRAINT "RestoreRun_backupRunId_fkey" FOREIGN KEY ("backupRunId") REFERENCES "BackupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoreRun" ADD CONSTRAINT "RestoreRun_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoreRun" ADD CONSTRAINT "RestoreRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
