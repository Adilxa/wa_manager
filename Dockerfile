# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# Production stage
FROM node:20-alpine
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY server ./server
COPY next.config.ts ./

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 && \
    mkdir -p .wwebjs_auth .wwebjs_cache logs && \
    chown -R nodejs:nodejs /app

USER nodejs
EXPOSE 3000 5001
CMD ["sh", "-c", "node server/index.js & npx next start"]
