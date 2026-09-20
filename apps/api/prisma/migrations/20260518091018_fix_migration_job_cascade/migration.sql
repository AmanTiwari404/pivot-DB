-- DropForeignKey
ALTER TABLE "MigrationJob" DROP CONSTRAINT "MigrationJob_destConnId_fkey";

-- DropForeignKey
ALTER TABLE "MigrationJob" DROP CONSTRAINT "MigrationJob_sourceConnId_fkey";

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_sourceConnId_fkey" FOREIGN KEY ("sourceConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationJob" ADD CONSTRAINT "MigrationJob_destConnId_fkey" FOREIGN KEY ("destConnId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
