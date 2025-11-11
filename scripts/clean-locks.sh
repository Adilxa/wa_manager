#!/bin/bash

# Скрипт для очистки lock-файлов Chromium без удаления сессий WhatsApp

echo "🧹 Cleaning Chromium lock files..."

# Остановка контейнера
echo "Stopping containers..."
docker-compose down

# Очистка lock файлов из volumes
echo "Removing lock files from wa_sessions volume..."
docker run --rm -v wa_manager_wa_sessions:/data alpine sh -c "
  find /data -name 'SingletonLock' -delete && \
  find /data -name 'SingletonCookie' -delete && \
  find /data -name 'SingletonSocket' -delete && \
  echo 'Cleaned lock files from sessions'
"

echo "Removing lock files from wa_cache volume..."
docker run --rm -v wa_manager_wa_cache:/data alpine sh -c "
  find /data -name 'SingletonLock' -delete && \
  find /data -name 'SingletonCookie' -delete && \
  find /data -name 'SingletonSocket' -delete && \
  echo 'Cleaned lock files from cache'
"

# Запуск контейнеров
echo "Starting containers..."
docker-compose up -d

echo "✅ Done! Containers are starting..."
echo "Check logs with: docker-compose logs -f wa-manager"
