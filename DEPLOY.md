# 🚀 WhatsApp Manager - Инструкция по деплою на VPS

## 📋 Содержание

1. [Подготовка VPS](#подготовка-vps)
2. [Установка зависимостей](#установка-зависимостей)
3. [Настройка проекта](#настройка-проекта)
4. [Деплой](#деплой)
5. [Обновление](#обновление)
6. [Решение проблем](#решение-проблем)

---

## 🖥️ Подготовка VPS

### Требования

- Ubuntu 20.04/22.04 или Debian 11/12
- Минимум 2GB RAM
- 20GB свободного места
- Docker и Docker Compose

### 1. Подключение к VPS

\`\`\`bash
ssh root@your-vps-ip
\`\`\`

### 2. Обновление системы

\`\`\`bash
apt update && apt upgrade -y
\`\`\`

### 3. Установка необходимых пакетов

\`\`\`bash
apt install -y curl git wget nano
\`\`\`

---

## 🐳 Установка зависимостей

### Установка Docker

\`\`\`bash

# Удаляем старые версии

apt remove docker docker-engine docker.io containerd runc

# Устанавливаем Docker

curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Добавляем в автозагрузку

systemctl enable docker
systemctl start docker

# Проверяем

docker --version
\`\`\`

### Установка Docker Compose

\`\`\`bash

# Устанавливаем Docker Compose

curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-\$(uname -s)-\$(uname -m)" -o /usr/local/bin/docker-compose

# Делаем исполняемым

chmod +x /usr/local/bin/docker-compose

# Проверяем

docker-compose --version
\`\`\`

---

## ⚙️ Настройка проекта

### 1. Клонирование проекта

\`\`\`bash

# Переходим в директорию

cd /var/www

# Клонируем проект

git clone <your-repo-url> wa_manager
cd wa_manager
\`\`\`

### 2. Настройка переменных окружения

\`\`\`bash

# Копируем пример .env

cp .env.example .env

# Редактируем .env

nano .env
\`\`\`

**Обязательно измените следующие параметры:**

\`\`\`env

# Database

DATABASE*URL="postgresql://postgres:СИЛЬНЫЙ*ПАРОЛЬ@postgres:5432/wa*manager?schema=public"
DIRECT_URL="postgresql://postgres:СИЛЬНЫЙ*ПАРОЛЬ@postgres:5432/wa_manager?schema=public"

# URLs (замените на ваш домен или IP)

NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_API_URL=https://your-domain.com

# API Port

API_PORT=5001

# Security (ВАЖНО: сгенерируйте новый секретный ключ)

API_SECRET_KEY=\$(openssl rand -base64 32)

# Environment

NODE_ENV=production
\`\`\`

---

## 🚀 Деплой

### 1. Первый запуск (с миграцией БД)

\`\`\`bash

# Собираем и запускаем контейнеры

docker-compose up -d --build

# Проверяем логи

docker-compose logs -f
\`\`\`

### 2. Проверка статуса

\`\`\`bash

# Проверяем запущенные контейнеры

docker-compose ps
\`\`\`

### 3. Проверка работоспособности

\`\`\`bash

# Проверяем API

curl http://localhost:5001/health

# Проверяем Next.js

curl http://localhost:3000
\`\`\`

---

## 🔄 Обновление проекта

### Обновление кода

\`\`\`bash
cd /var/www/wa_manager

# Останавливаем контейнеры

docker-compose down

# Получаем последние изменения

git pull

# Пересобираем и запускаем

docker-compose up -d --build

# Проверяем логи

docker-compose logs -f
\`\`\`

---

## 🛠️ Полезные команды

### Просмотр логов

\`\`\`bash

# Все логи

docker-compose logs -f

# Только wa-manager

docker-compose logs -f wa-manager
\`\`\`

### Перезапуск сервисов

\`\`\`bash

# Перезапуск всех контейнеров

docker-compose restart

# Перезапуск только wa-manager

docker-compose restart wa-manager
\`\`\`

---

## 🔧 Решение проблем

### Проблема: База данных не найдена

**Решение:**
\`\`\`bash

# Проверить статус postgres

docker-compose logs postgres

# Пересоздать базу

docker-compose down
docker volume rm wa_manager_postgres_data
docker-compose up -d
\`\`\`

### Проблема: Порты уже заняты

**Решение:**
\`\`\`bash

# Проверить, что использует порты

netstat -tulpn | grep :3000
netstat -tulpn | grep :5001
\`\`\`

---

## 📞 API Endpoints

### Основные эндпоинты:

- \`GET /health\` - Статус сервера
- \`GET /api/accounts\` - Список аккаунтов
- \`POST /api/accounts\` - Создать аккаунт
- \`POST /api/accounts/:id/connect\` - Подключить аккаунт
- \`POST /api/accounts/:id/disconnect\` - Отключить аккаунт
- \`DELETE /api/accounts/:id\` - Удалить аккаунт
- \`POST /api/messages/send\` - Отправить сообщение

### Пример отправки сообщения:

\`\`\`bash
curl -X POST http://localhost:5001/api/messages/send \
 -H "Content-Type: application/json" \
 -d '{
"accountId": "your-account-id",
"to": "1234567890",
"message": "Hello from WhatsApp API!"
}'
\`\`\`

---

## 🎯 Финальная проверка

После деплоя проверьте:

1. ✅ Контейнеры запущены: \`docker-compose ps\`
2. ✅ Health check работает: \`curl http://localhost:5001/health\`
3. ✅ Интерфейс доступен: \`curl http://localhost:3000\`
4. ✅ Можно создать аккаунт
5. ✅ QR код генерируется
6. ✅ Можно отправить сообщение

---

## 🚀 Готово!

Ваш WhatsApp Manager на Baileys теперь работает!

**Dashboard:** http://your-domain.com (или http://your-ip:3000)

**Возникли проблемы?** Проверьте логи: \`docker-compose logs -f\`
