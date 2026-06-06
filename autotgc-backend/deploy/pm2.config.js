// PM2 process config. Runs the backend as the non-root 'autotgc' user.
//
// Split topology (perf): the API and the background work run as SEPARATE
// processes so a slow AI call or a heavy queue/cron job can never block the API
// event loop (this was the cause of the node-cron "missed execution" warnings):
//   - autotgc-api    : RUN_MODE=api    → HTTP only, listens on PORT.
//   - autotgc-worker : RUN_MODE=worker → BullMQ workers + cron, no HTTP listener.
//
// Both load the same /opt/autotgc/.env; RUN_MODE is injected per-app below and
// overrides any RUN_MODE in the env file. max_memory_restart guards the single
// VM against a runaway process.
//
// API scaling (opt-in, off by default): on a multi-vCPU VM the single fork-mode
// API instance only uses ONE core, so concurrent requests queue behind each
// other on one event loop. Setting API_INSTANCES switches autotgc-api to PM2
// cluster mode (built-in load balancer across N forked workers sharing the same
// port). This is SAFE here because the API process is effectively stateless:
//   - rate limiting is Redis-backed (registerSecurity), so the limit is shared
//     across instances rather than per-process;
//   - realtime SSE/WS fan-out rides the Redis-backed event bus (RedisEventBus),
//     so an event published by the worker reaches clients on ANY API instance;
//   - sessions/JWT are verified against Postgres, not in-process memory.
// Trade-offs to weigh before enabling on this box:
//   - each instance is a full Node process (~its own heap; max_memory_restart
//     is PER instance, so N×600M worst case) — leave headroom for Postgres,
//     Redis, and the worker;
//   - each instance opens its own Prisma pool, so total Postgres connections are
//     (API_INSTANCES + worker) × DB_CONNECTION_LIMIT — keep that under
//     Postgres max_connections (set DB_CONNECTION_LIMIT accordingly);
//   - the in-VM event bus REQUIRES Redis (REDIS_URL) for cross-instance realtime;
//     without it the in-memory bus only reaches clients on the same instance.
// Recommendation for a single shared VM: keep fork/1 unless the API is CPU- or
// event-loop-bound under load. If scaling, start small — API_INSTANCES=2 (or at
// most vCPU-1, reserving a core for Postgres/Redis/worker) — and watch RAM +
// Postgres connection count. Leave unset to keep the original fork/1 behavior.
const apiInstances = parseInt(process.env.API_INSTANCES || '', 10);
const apiCluster = Number.isInteger(apiInstances) && apiInstances > 1;

module.exports = {
  apps: [
    {
      name: 'autotgc-api',
      script: 'dist/index.js',
      cwd: '/opt/autotgc',
      // Default: 1 fork (unchanged). Opt in to cluster mode via API_INSTANCES>1.
      instances: apiCluster ? apiInstances : 1,
      exec_mode: apiCluster ? 'cluster' : 'fork',
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '600M',
      env_file: '/opt/autotgc/.env',
      env: { RUN_MODE: 'api' },
      out_file: '/var/log/autotgc/api-out.log',
      error_file: '/var/log/autotgc/api-err.log',
      time: true,
    },
    {
      name: 'autotgc-worker',
      script: 'dist/index.js',
      cwd: '/opt/autotgc',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '500M',
      env_file: '/opt/autotgc/.env',
      env: { RUN_MODE: 'worker' },
      out_file: '/var/log/autotgc/worker-out.log',
      error_file: '/var/log/autotgc/worker-err.log',
      time: true,
    },
  ],
};
