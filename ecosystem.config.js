module.exports = {
  apps: [
    {
      name: "api-server",
      script: "./server/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // Restart only on memory limit - 5GB for 50+ clients
      max_memory_restart: "5200M",
      env: {
        NODE_ENV: "production",
        API_PORT: process.env.API_PORT || 5001,
        // Enable garbage collection - 5GB heap for 50+ accounts
        NODE_OPTIONS: "--expose-gc --max-old-space-size=5120",
      },
      // Restart strategy
      min_uptime: "10s",
      max_restarts: 50,
      restart_delay: 3000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown - increased timeout
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 10000,
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
      // Restart only on memory limit
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        NODE_OPTIONS: "--max-old-space-size=400",
      },
      // Restart strategy
      min_uptime: "10s",
      max_restarts: 50,
      restart_delay: 3000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: "./logs/nextjs-error.log",
      out_file: "./logs/nextjs-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 30000,
    },
    {
      name: "services-monitor",
      script: "server/monitor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "-1003128708715",
        REDIS_HOST: process.env.REDIS_HOST || "localhost",
        REDIS_PORT: process.env.REDIS_PORT || 6379,
        REDIS_PASSWORD: process.env.REDIS_PASSWORD,
      },
      // Restart settings
      restart_delay: 10000,
      max_restarts: 20,
      min_uptime: "30s",
      // Exponential backoff
      exp_backoff_restart_delay: 500,
      // Logging
      error_file: "./logs/monitor-error.log",
      out_file: "./logs/monitor-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 15000,
      listen_timeout: 5000,
      shutdown_with_message: true,
    },
  ],
};
