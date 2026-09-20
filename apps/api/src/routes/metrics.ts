import { FastifyInstance } from 'fastify';
import { metricsService } from '../services/metrics.service.js';
import { sqlMetricsService } from '../services/sql-metrics.service.js';

export async function metricsRoutes(app: FastifyInstance) {
  /**
   * Prometheus scrape endpoint.
   *
   * Concatenates Mongo (`mongodb_*`) and SQL (`sqlmon_*`) metrics from two
   * separate registries — both prefixes are disjoint so simple text join
   * produces valid exposition. We run both collectors in parallel because
   * they hit different databases.
   */
  app.get('/metrics', async (_req, reply) => {
    const [mongoMetrics, sqlMetrics] = await Promise.all([
      metricsService.getMetrics(),
      sqlMetricsService.getMetrics(),
    ]);
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(mongoMetrics.trimEnd() + '\n' + sqlMetrics.trimEnd() + '\n');
  });
}
