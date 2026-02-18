module.exports = {
  apps: [
    {
      name: "api-server",
      script: "./server/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "600M",
      // Restart every 12 hours for memory cleanup
      cron_restart: "0 */12 * * *",
      env: {
        NODE_ENV: "production",
        API_PORT: process.env.API_PORT || 5001,
        // Enable garbage collection exposure
        NODE_OPTIONS: "--expose-gc --max-old-space-size=512",
      },
      // Restart strategy
      min_uptime: "30s",
      max_restarts: 15,
      restart_delay: 5000,
      // Exponential backoff
      exp_backoff_restart_delay: 500,
      // Logging
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 15000,
      // Signal to indicate process is ready
      shutdown_with_message: true,
    },
    {
      name: "nextjs-server",
      script: "npx",
      args: "next start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "350M",
      // Restart every 12 hours for memory cleanup
      cron_restart: "0 */12 * * *",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NODE_OPTIONS: "--max-old-space-size=300",
      },
      // Restart strategy
      min_uptime: "30s",
      max_restarts: 15,
      restart_delay: 5000,
      // Exponential backoff
      exp_backoff_restart_delay: 500,
      // Logging
      error_file: "./logs/nextjs-error.log",
      out_file: "./logs/nextjs-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 15000,
    },
  ],
};
