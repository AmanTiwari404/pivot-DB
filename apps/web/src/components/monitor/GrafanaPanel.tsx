interface GrafanaPanelProps {
  /** Numeric `id` of the panel inside the dashboard JSON. */
  panelId: number
  /**
   * Dashboard UID. Defaults to the Mongo dashboard so existing call-sites
   * keep working without changes. SQL monitors pass `sqlmon-postgres` /
   * `sqlmon-mysql`.
   */
  dashboardUid?: string
  height?: number
  /** Grafana template variables, applied as `var-<key>=<value>` query params. */
  vars?: Record<string, string>
}

/**
 * Single-panel Grafana iframe.
 *
 * Uses Grafana's `/d-solo/<uid>` route which renders just one panel without
 * any of Grafana's chrome. The `theme=dark` matches our app theme; `refresh=5s`
 * keeps the chart live without overwhelming Prometheus.
 *
 * The iframe assumes Grafana is configured to allow framing (we set
 * `allow_embedding = true` in grafana.ini and rely on the same-origin proxy
 * behaviour of Coolify in prod / localhost in dev).
 */
export function GrafanaPanel({
  panelId,
  dashboardUid = 'mongodb-adv-vis',
  height = 300,
  vars = {},
}: GrafanaPanelProps) {
  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL ?? 'http://localhost:3003'
  const varString  = Object.entries(vars)
    .map(([k, v]) => `var-${k}=${encodeURIComponent(v)}`)
    .join('&')
  const src = `${grafanaUrl}/d-solo/${dashboardUid}` +
              `?orgId=1&panelId=${panelId}&theme=dark&refresh=5s` +
              (varString ? '&' + varString : '')

  return (
    <iframe
      src={src}
      width="100%"
      height={height}
      frameBorder={0}
      style={{ borderRadius: 8 }}
      title={`Grafana panel ${dashboardUid}/${panelId}`}
    />
  )
}
