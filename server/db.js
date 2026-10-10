const { PrismaClient } = require("@prisma/client");

// Prisma's default pool is (2 * CPUs + 1) — only 3 connections on a 1 vCPU box, shared by
// the API and every account's send worker. Raise it unless DATABASE_URL already sets one.
function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", process.env.DB_POOL_SIZE || "20");
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", "20");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const url = databaseUrl();

// Single Prisma client (and connection pool) for the whole API process.
const prisma = new PrismaClient({
  log: ["error", "warn"],
  ...(url ? { datasources: { db: { url } } } : {}),
});

module.exports = prisma;
