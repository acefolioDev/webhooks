/** What `runOnce()` did with the deliveries it claimed. */
export interface WebhookWorkerRunResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  released: number;
  leaseLost: number;
}
