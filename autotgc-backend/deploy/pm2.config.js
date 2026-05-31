// PM2 process config. Runs the backend as the non-root 'autotgc' user with restart backoff.
module.exports = {
  apps: [
    {
      name: 'autotgc-backend',
      script: 'dist/index.js',
      cwd: '/opt/autotgc',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      env_file: '/opt/autotgc/.env',
      out_file: '/var/log/autotgc/out.log',
      error_file: '/var/log/autotgc/err.log',
      time: true,
    },
  ],
};
