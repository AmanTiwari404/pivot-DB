-- CreateTable
CREATE TABLE "MigrationJobV2" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sourceConnId" TEXT NOT NULL,
    "destConnId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "destType" TEXT NOT NULL,
    "sourceDatabase" TEXT,
    "destDatabase" TEXT,
    "schemaMapping" JSONB,
    "typeMappingRules" JSONB,
    "sampleSize" INTEGER NOT NULL DEFAULT 1000,
    "batchSize" INTEGER NOT NULL DEFAULT 1000,
    "parallelism" INTEGER NOT NULL DEFAULT 1,
    "dropExisting" BOOLEAN NOT NULL DEFAULT false,
    "failOnTypeConflict" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationJobV2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRunV2" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'queued',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalNamespaces" INTEGER NOT NULL DEFAULT 0,
    "succeededNs" INTEGER NOT NULL DEFAULT 0,
    "failedNs" INTEGER NOT NULL DEFAULT 0,
    "totalWritten" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "progress" JSONB,
    "warnings" JSONB,
    "errors" JSONB,
    "ddlPreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRunV2_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MigrationJobV2" ADD CONSTRAINT "MigrationJobV2_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJobV2" ADD CONSTRAINT "MigrationJobV2_sourceConnId_fkey" FOREIGN KEY ("sourceConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJobV2" ADD CONSTRAINT "MigrationJobV2_destConnId_fkey" FOREIGN KEY ("destConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationRunV2" ADD CONSTRAINT "MigrationRunV2_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "MigrationJobV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;
