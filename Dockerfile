# ==========================================
# Build stage
# ==========================================
FROM node:20-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy all source files
COPY . .

ARG NEXT_PUBLIC_APP_URL=https://ilovesanzhar.click
ARG NEXT_PUBLIC_API_URL=https://ilovesanzhar.click
ARG NEXT_PUBLIC_USE_WEBSOCKET=true

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_USE_WEBSOCKET=$NEXT_PUBLIC_USE_WEBSOCKET

# Generate Prisma client and build Next.js
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ==========================================
# Production stage
# ==========================================
FROM node:20-bookworm-slim

# Set production environment variables
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy package files and pruned production dependencies from builder
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy built files from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Copy application files
COPY prisma ./prisma
COPY server ./server
COPY next.config.ts ./
COPY ecosystem.config.js ./

# Create directories for Baileys auth sessions and logs
RUN mkdir -p .baileys_auth logs

# Create non-root user for security
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose ports (Next.js and API)
EXPOSE 3000 5001

# Health check - check both services (increased timeout for stability)
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=5 \
    CMD ["node", "-e", "const http=require('http');const check=(port,path='/')=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path,timeout:5000},res=>{res.resume();res.statusCode<500?resolve():reject(new Error(String(res.statusCode)))});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')))});Promise.all([check(3000),check(5001,'/health')]).then(()=>process.exit(0),()=>process.exit(1));"]

# Start with PM2 (auto-restarts processes if they crash)
# --expose-gc allows manual GC calls for memory management
CMD ["node", "server/start-production.js"]
