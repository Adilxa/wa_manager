module.exports = {
  apps: [
    {
      name: "api-server",
      script: "./server/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        API_PORT: process.env.API_PORT || 5001,
      },
      // Restart strategy
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,
    },
    {
      name: "nextjs-server",
      script: "npx",
      args: "next start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      // Restart strategy
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 4000,
      // Exponential backoff
      exp_backoff_restart_delay: 100,
      // Logging
      error_file: "./logs/nextjs-error.log",
      out_file: "./logs/nextjs-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
    },
  ],
};
