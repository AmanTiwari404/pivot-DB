import type { AlertRule, AlertEvent } from '@prisma/client';
import { prisma } from './prisma.js';
import { sendAlertEmail } from './notifications/email.js';
import { sendAlertWebhook } from './notifications/webhook.js';
import type { MonitorSnapshot } from '../services/monitor.service.js';

const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Evaluate every enabled alert rule for a connection against a fresh
 * snapshot. Called fire-and-forget from the snapshot route — must NEVER
 * throw or block (the snapshot response should be returned regardless).
 *
 * State machine per rule:
 *   ok        → condition becomes true → set firingStartedAt
 *   pending   → condition stays true for durationMinutes → status=firing + create AlertEvent + notify
 *   firing    → condition becomes false → status=ok + auto-resolve open events
 */
export async function evaluateAlerts(
  connectionId: string,
  profileId: string,
  snapshot: MonitorSnapshot,
): Promise<void> {
  const rules = await prisma.alertRule.findMany({
    where: { connectionId, profileId, enabled: true, status: { not: 'paused' } },
  });

  const now = new Date();

  for (const rule of rules) {
    try {
      const value = extractMetricValue(snapshot, rule.metric);
      // Metric not available (e.g. replicationLag on standalone) — skip silently
      if (value === null) continue;

      const conditionMet = evaluateCondition(value, rule.condition, rule.threshold);

      if (conditionMet) {
        if (!rule.firingStartedAt) {
          // First time condition is true — start the duration clock
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { firingStartedAt: now, lastEvaluatedAt: now },
          });
          continue;
        }

        const minutesFiring = (now.getTime() - rule.firingStartedAt.getTime()) / 60000;

        if (minutesFiring >= rule.durationMinutes && rule.status !== 'firing') {
          // Duration threshold crossed — actually fire the alert
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { status: 'firing', lastEvaluatedAt: now },
          });

          const event = await prisma.alertEvent.create({
            data: {
              ruleId: rule.id,
              profileId,
              connectionId,
              metric: rule.metric,
              value,
              threshold: rule.threshold,
              condition: rule.condition,
              status: 'firing',
              firedAt: now,
            },
          });

          const cooldownOk = !rule.lastNotifiedAt ||
            (now.getTime() - rule.lastNotifiedAt.getTime()) > NOTIFY_COOLDOWN_MS;

          if (cooldownOk) {
            await notify(rule, event, value, snapshot);
            await prisma.alertRule.update({
              where: { id: rule.id },
              data: { lastNotifiedAt: now },
            });
            await prisma.alertEvent.update({
              where: { id: event.id },
              data: { notified: true },
            });
          }
        } else {
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { lastEvaluatedAt: now },
          });
        }
      } else {
        // Condition NOT met
        if (rule.status === 'firing') {
          // Auto-resolve all open firing events for this rule
          await prisma.alertEvent.updateMany({
            where: { ruleId: rule.id, status: 'firing' },
            data: { status: 'resolved', resolvedAt: now },
          });
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { status: 'ok', firingStartedAt: null, lastEvaluatedAt: now },
          });
        } else if (rule.firingStartedAt) {
          // Was pending but condition recovered — reset the clock
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { firingStartedAt: null, lastEvaluatedAt: now },
          });
        } else {
          await prisma.alertRule.update({
            where: { id: rule.id },
            data: { lastEvaluatedAt: now },
          });
        }
      }
    } catch (err) {
      console.error(`[AlertEvaluator] rule ${rule.id} failed:`, (err as Error).message);
    }
  }
}

export function extractMetricValue(snapshot: MonitorSnapshot, metric: string): number | null {
  switch (metric) {
    case 'currentConnections':   return snapshot.currentConnections;
    case 'availableConnections': return snapshot.availableConnections;
    case 'memResident':          return snapshot.memResident;
    case 'memVirtual':           return snapshot.memVirtual;
    case 'opsPerSecTotal':
      return Object.values(snapshot.opsPerSec).reduce((a, b) => a + b, 0);
    case 'replicationLag': {
      if (!snapshot.replicaSet) return null;
      const lags = snapshot.replicaSet.members
        .map((m) => m.lagSeconds)
        .filter((l): l is number => l !== null);
      return lags.length > 0 ? Math.max(...lags) : 0;
    }
    case 'wtCachePercent':
      if (!snapshot.wtCacheMaxMB || snapshot.wtCacheMaxMB === 0) return null;
      return (snapshot.wtCacheUsedMB / snapshot.wtCacheMaxMB) * 100;
    case 'networkBytesIn':  return snapshot.networkBytesIn;
    case 'networkBytesOut': return snapshot.networkBytesOut;
    default: return null;
  }
}

export function evaluateCondition(value: number, condition: string, threshold: number): boolean {
  switch (condition) {
    case 'gt':  return value > threshold;
    case 'lt':  return value < threshold;
    case 'gte': return value >= threshold;
    case 'lte': return value <= threshold;
    default:    return false;
  }
}

async function notify(rule: AlertRule, event: AlertEvent, value: number, snapshot: MonitorSnapshot) {
  const message = formatAlertMessage(rule, value, snapshot);

  if (rule.notifyEmail) {
    await sendAlertEmail(rule.notifyEmail, rule.name, message).catch((err: Error) =>
      console.error('[Alert] Email failed:', err.message),
    );
  }

  if (rule.notifyWebhook) {
    await sendAlertWebhook(rule.notifyWebhook, {
      ruleName: rule.name,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      condition: rule.condition,
      connectionId: rule.connectionId,
      firedAt: event.firedAt,
      eventId: event.id,
    });
  }
}

const METRIC_LABEL: Record<string, string> = {
  currentConnections:   'Current Connections',
  availableConnections: 'Available Connections',
  memResident:          'Resident Memory (MB)',
  memVirtual:           'Virtual Memory (MB)',
  opsPerSecTotal:       'Operations/sec',
  replicationLag:       'Replication Lag (s)',
  wtCachePercent:       'WiredTiger Cache (%)',
  networkBytesIn:       'Network In (bytes/s)',
  networkBytesOut:      'Network Out (bytes/s)',
};

const COND_LABEL: Record<string, string> = {
  gt:  'exceeded',
  lt:  'dropped below',
  gte: 'reached',
  lte: 'fell to',
};

function formatAlertMessage(rule: AlertRule, value: number, snapshot: MonitorSnapshot): string {
  const metric = METRIC_LABEL[rule.metric] ?? rule.metric;
  const cond   = COND_LABEL[rule.condition] ?? rule.condition;
  return (
    `Alert: ${rule.name}\n` +
    `${metric} ${cond} ${rule.threshold}\n` +
    `Current value: ${value.toFixed(2)}\n` +
    `Host: ${snapshot.host}\n` +
    `Time: ${new Date().toISOString()}`
  );
}
