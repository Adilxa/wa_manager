const { spawn } = require("child_process");

let shuttingDown = false;
const children = new Map();

function startProcess(name, command, args, extraEnv = {}) {
  if (shuttingDown) return;

  console.log(`[start] ${name}: ${command} ${args.join(" ")}`);

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "inherit",
  });

  children.set(name, child);

  child.on("exit", (code, signal) => {
    children.delete(name);
    console.error(`[start] ${name} exited code=${code} signal=${signal}`);

    if (!shuttingDown) {
      setTimeout(() => startProcess(name, command, args, extraEnv), 3000);
    }
  });

  child.on("error", (error) => {
    console.error(`[start] ${name} failed:`, error);
  });
}

function shutdown(signal) {
  shuttingDown = true;
  console.log(`[start] received ${signal}, stopping children`);

  for (const child of children.values()) {
    child.kill(signal);
  }

  setTimeout(() => process.exit(0), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startProcess("api-server", "node", ["server/index.js"], {
  NODE_ENV: "production",
  API_PORT: process.env.API_PORT || "5001",
  API_MEMORY_LIMIT_MB:
    process.env.API_MEMORY_LIMIT_MB ||
    process.env.API_NODE_MAX_OLD_SPACE_SIZE ||
    "9216",
  NODE_OPTIONS: `--expose-gc --max-old-space-size=${
    process.env.API_NODE_MAX_OLD_SPACE_SIZE || "9216"
  }`,
});

startProcess("nextjs-server", "./node_modules/.bin/next", ["start"], {
  NODE_ENV: "production",
  PORT: "3000",
  NODE_OPTIONS: `--max-old-space-size=${
    process.env.NEXTJS_NODE_MAX_OLD_SPACE_SIZE || "512"
  }`,
});
