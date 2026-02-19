module.exports = {
  apps: [
    {
      name: 'whatsapp-api',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Restart only on memory limit (no cron - causes kill issues)
      max_memory_restart: '8000M',
      env: {
        NODE_ENV: 'production',
        API_PORT: process.env.API_PORT || 5001,
        // Enable garbage collection - 8GB heap for heavy workloads
        NODE_OPTIONS: '--expose-gc --max-old-space-size=8192',
      },
      // Restart strategy
      min_uptime: '10s',
      max_restarts: 50,
      restart_delay: 3000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Auto-restart on exceptions
      ignore_watch: ['node_modules', 'logs', '.next', '.baileys_auth'],
      // Graceful shutdown - increased timeout
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
    {
      name: 'nextjs-frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Restart only on memory limit
      max_memory_restart: '2000M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=2048',
      },
      // Restart strategy
      min_uptime: '10s',
      max_restarts: 50,
      restart_delay: 3000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Auto-restart on exceptions
      ignore_watch: ['node_modules', 'logs', '.next', '.baileys_auth'],
      // Graceful shutdown
      kill_timeout: 30000,
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
    {
      name: 'services-monitor',
      script: 'server/monitor.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        REDIS_HOST: process.env.REDIS_HOST || 'localhost',
        REDIS_PORT: process.env.REDIS_PORT || 6379,
        REDIS_PASSWORD: process.env.REDIS_PASSWORD,
      },
      // Auto-restart settings
      restart_delay: 10000,
      max_restarts: 50,
      min_uptime: '30s',
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: './logs/monitor-error.log',
      out_file: './logs/monitor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 30000,
      listen_timeout: 5000,
      shutdown_with_message: true,
    },
  ],
};
