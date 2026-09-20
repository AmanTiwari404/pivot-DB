/**
 * POSTs an alert payload to a user-supplied webhook URL.
 * 5-second timeout; failures are logged but never thrown so a flaky
 * webhook does not break the alert pipeline.
 */
export async function sendAlertWebhook(url: string, payload: object): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[Alert] Webhook ${url} returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[Alert] Webhook failed:', (err as Error).message);
  }
}
