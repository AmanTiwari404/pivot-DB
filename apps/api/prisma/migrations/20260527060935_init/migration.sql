-- CreateTable
CREATE TABLE "CdcSyncJob" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sourceConnId" TEXT NOT NULL,
    "destConnId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "destType" TEXT NOT NULL,
    "sourceDatabase" TEXT,
    "destDatabase" TEXT,
    "namespaces" JSONB,
    "schemaMapping" JSONB,
    "typeMappingRules" JSONB,
    "bootstrap" TEXT NOT NULL DEFAULT 'snapshot',
    "cursor" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CdcSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdcSyncRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'bootstrapping',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inserts" INTEGER NOT NULL DEFAULT 0,
    "updates" INTEGER NOT NULL DEFAULT 0,
    "deletes" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "endCursor" JSONB,

    CONSTRAINT "CdcSyncRun_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CdcSyncJob" ADD CONSTRAINT "CdcSyncJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CdcSyncJob" ADD CONSTRAINT "CdcSyncJob_sourceConnId_fkey" FOREIGN KEY ("sourceConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CdcSyncJob" ADD CONSTRAINT "CdcSyncJob_destConnId_fkey" FOREIGN KEY ("destConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CdcSyncRun" ADD CONSTRAINT "CdcSyncRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CdcSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
