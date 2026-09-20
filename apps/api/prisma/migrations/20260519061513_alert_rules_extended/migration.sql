-- Drop & recreate AlertRule and AlertEvent with the new shape.
-- Acceptable data loss: alert state is transient monitoring metadata
-- that re-evaluates within seconds of the rules being recreated.

DROP TABLE IF EXISTS "AlertEvent" CASCADE;
DROP TABLE IF EXISTS "AlertRule"  CASCADE;

CREATE TABLE "AlertRule" (
    "id"               TEXT NOT NULL,
    "profileId"        TEXT NOT NULL,
    "connectionId"     TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "metric"           TEXT NOT NULL,
    "condition"        TEXT NOT NULL,
    "threshold"        DOUBLE PRECISION NOT NULL,
    "durationMinutes"  INTEGER NOT NULL DEFAULT 1,
    "enabled"          BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail"      TEXT,
    "notifyWebhook"    TEXT,
    "status"           TEXT NOT NULL DEFAULT 'ok',
    "firingStartedAt"  TIMESTAMP(3),
    "lastEvaluatedAt"  TIMESTAMP(3),
    "lastNotifiedAt"   TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertEvent" (
    "id"             TEXT NOT NULL,
    "ruleId"         TEXT NOT NULL,
    "profileId"      TEXT NOT NULL,
    "connectionId"   TEXT NOT NULL,
    "metric"         TEXT NOT NULL,
    "value"          DOUBLE PRECISION NOT NULL,
    "threshold"      DOUBLE PRECISION NOT NULL,
    "condition"      TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'firing',
    "firedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"     TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "note"           TEXT,
    "notified"       BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AlertRule"
  ADD CONSTRAINT "AlertRule_profileId_fkey"
    FOREIGN KEY ("profileId")    REFERENCES "Profile"("id")    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AlertRule_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlertEvent"
  ADD CONSTRAINT "AlertEvent_ruleId_fkey"
    FOREIGN KEY ("ruleId")    REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AlertEvent_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id")   ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AlertRule_connectionId_idx"    ON "AlertRule"("connectionId");
CREATE INDEX "AlertRule_profileId_idx"       ON "AlertRule"("profileId");
CREATE INDEX "AlertEvent_ruleId_firedAt_idx" ON "AlertEvent"("ruleId", "firedAt");
CREATE INDEX "AlertEvent_connectionId_idx"   ON "AlertEvent"("connectionId");
