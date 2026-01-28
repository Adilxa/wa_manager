module.exports = {
  apps: [
    {
      name: 'whatsapp-api',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: '5001'
      },
      // Auto-restart settings
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      // Kill timeout
      kill_timeout: 5000,
      // Logging
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Auto-restart on exceptions
      ignore_watch: ['node_modules', 'logs', '.next', '.baileys_auth'],
      // Graceful shutdown
      listen_timeout: 10000,
      shutdown_with_message: true
    },
    {
      name: 'nextjs-frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000'
      },
      // Auto-restart settings
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      // Kill timeout
      kill_timeout: 5000,
      // Logging
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Auto-restart on exceptions
      ignore_watch: ['node_modules', 'logs', '.next', '.baileys_auth'],
      // Graceful shutdown
      listen_timeout: 10000,
      shutdown_with_message: true
    },
    {
      name: 'services-monitor',
      script: 'server/monitor.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      env: {
        NODE_ENV: 'production'
      },
      // Auto-restart settings
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: '30s',
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      // Kill timeout
      kill_timeout: 5000,
      // Logging
      error_file: './logs/monitor-error.log',
      out_file: './logs/monitor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Graceful shutdown
      listen_timeout: 5000,
      shutdown_with_message: true
    }
  ]
};
