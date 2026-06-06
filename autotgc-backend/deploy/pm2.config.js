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
module.exports = {
  apps: [
    {
      name: 'autotgc-api',
      script: 'dist/index.js',
      cwd: '/opt/autotgc',
      instances: 1,
      exec_mode: 'fork',
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
