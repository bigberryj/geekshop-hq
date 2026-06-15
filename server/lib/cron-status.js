/**
 * Safe cron status projection for the dashboard.
 * Never expose full prompts, scripts, or secrets in API responses.
 */

export function summarizeCronJobs(payload = {}) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const safeJobs = jobs.map((j) => ({
    name: j.name || j.id || 'unnamed',
    enabled: Boolean(j.enabled),
    last_status: j.last_status || null,
    next_run_at: j.next_run_at || null,
  }));
  return {
    enabled_count: safeJobs.filter((j) => j.enabled).length,
    jobs: safeJobs,
  };
}
