/**
 * Dashboard pure helpers (Lead/Dashboard Req 16, 18) — window + staleness predicates.
 */
export function isUpcoming(scheduledAt: Date, now: Date, windowDays = 7): boolean {
  const t = scheduledAt.getTime();
  const lower = now.getTime();
  const upper = lower + windowDays * 86400 * 1000;
  return t >= lower && t <= upper;
}

/**
 * Data-sync staleness: stale iff (now - lastSync) > threshold. At/within threshold = current.
 */
export function isDataStale(lastSync: Date | null, now: Date, thresholdHours = 6): boolean {
  if (!lastSync) return true;
  const ageMs = now.getTime() - lastSync.getTime();
  return ageMs > thresholdHours * 3600 * 1000;
}
