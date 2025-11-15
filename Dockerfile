# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Generate Prisma client and build Next.js
RUN npx prisma generate && npm run build

# Production stage
FROM node:20-alpine

# Set production environment
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/public ./public
COPY prisma ./prisma
COPY server ./server
COPY next.config.ts ./

# Create directories for Baileys auth and logs
RUN mkdir -p .baileys_auth logs

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose ports
EXPOSE 3000 5001

# Start both Next.js and API server
CMD ["sh", "-c", "npx prisma migrate deploy && node server/index.js & npx next start"]
