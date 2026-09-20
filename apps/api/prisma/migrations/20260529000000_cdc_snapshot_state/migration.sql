-- AlterTable: track snapshot completion separately from cursor
ALTER TABLE "CdcSyncJob" ADD COLUMN "snapshotState" TEXT NOT NULL DEFAULT 'pending';

-- Backfill: any existing job that already moved past bootstrap should be
-- considered done so we don't accidentally re-snapshot on next worker pickup.
-- Conservative heuristic: status is already "tailing"/"paused", OR bootstrap
-- mode is "tail" (no snapshot was ever required).
UPDATE "CdcSyncJob"
SET "snapshotState" = 'done'
WHERE "bootstrap" = 'tail'
   OR "status" IN ('tailing', 'paused');
