# ==========================================
# Build stage
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install git and build dependencies (required for Baileys and native modules)
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    curl

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy all source files
COPY . .

# Generate Prisma client and build Next.js
RUN npx prisma generate && npm run build

# ==========================================
# Production stage
# ==========================================
FROM node:20-alpine

# Set production environment variables
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Install git (required for Baileys in production)
RUN apk add --no-cache git curl

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/public ./public

# Copy application files
COPY prisma ./prisma
COPY server ./server
COPY next.config.ts ./
COPY ecosystem.config.js ./

# Create directories for Baileys auth sessions and logs
RUN mkdir -p .baileys_auth logs

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose ports (Next.js and API)
EXPOSE 3000 5001

# Health check - check both services (increased timeout for stability)
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=5 \
    CMD curl -sf http://localhost:3000 -o /dev/null && curl -sf http://localhost:5001/health -o /dev/null || exit 1

# Start with PM2 (auto-restarts processes if they crash)
# --expose-gc allows manual GC calls for memory management
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:pm2"]
