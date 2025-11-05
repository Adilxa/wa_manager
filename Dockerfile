# Multi-stage build для оптимизации размера образа

# Stage 1: Build Next.js
FROM node:18-alpine AS nextjs-builder
WORKDIR /app

# Копируем package files
COPY package*.json ./
RUN npm ci

# Копируем исходники
COPY . .

# Генерируем Prisma Client
RUN npx prisma generate

# Собираем Next.js
RUN npm run build

# Stage 2: Production image
FROM node:18-slim AS production

# Установка зависимостей для Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm ci --only=production

# Копируем собранный Next.js из builder stage
COPY --from=nextjs-builder /app/.next ./.next
COPY --from=nextjs-builder /app/public ./public
COPY --from=nextjs-builder /app/node_modules/.prisma ./node_modules/.prisma

# Копируем остальные необходимые файлы
COPY prisma ./prisma
COPY server ./server
COPY app ./app
COPY next.config.ts ./
COPY tailwind.config.js ./
COPY postcss.config.js ./
COPY tsconfig.json ./

# Генерируем Prisma Client в production
RUN npx prisma generate

# Создаем non-root пользователя
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app

# Создаем директории для WhatsApp данных
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/logs
RUN chown -R appuser:appuser /app/.wwebjs_auth /app/.wwebjs_cache /app/logs

USER appuser

# Открываем порты
EXPOSE 3000 5001

# Устанавливаем переменные окружения
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Запускаем оба сервера
CMD ["sh", "-c", "node server/index.js & npm start"]
