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
  ],
};
