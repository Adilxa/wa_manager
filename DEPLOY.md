# 🚀 Инструкция по деплою WhatsApp Manager

## Архитектура деплоя

```
┌─────────────────────────────────────────────────────┐
│  VPS/Docker (Next.js UI + Express API + WhatsApp)   │
│  http://your-server.com:3000 - UI                   │
│  http://your-server.com:5001 - API                  │
│  - Next.js Frontend                                 │
│  - WhatsApp Web.js клиенты                          │
│  - Puppeteer + Chrome                               │
│  - PostgreSQL Database                              │
└─────────────────────────────────────────────────────┘
```

## Порты
- **3000** - Next.js UI (публичный доступ)
- **5001** - WhatsApp API (внутренний/публичный доступ)
- **5432** - PostgreSQL (только внутри Docker сети)

---

## 🚀 Быстрый старт (автоматический деплой)

### Шаг 1: Подключение к VPS

```bash
ssh user@your-server-ip
```

### Шаг 2: Клонирование репозитория

```bash
git clone <your-repo-url> wa-manager
cd wa-manager
```

### Шаг 3: Настройка переменных окружения

```bash
# Копируем пример
cp .env.example .env

# Редактируем конфигурацию
nano .env
```

Настройте следующие параметры:

```env
# Database (встроенный PostgreSQL в Docker)
DATABASE_URL="postgresql://postgres:SECURE_PASSWORD@postgres:5432/wa_manager?schema=public"
DIRECT_URL="postgresql://postgres:SECURE_PASSWORD@postgres:5432/wa_manager?schema=public"

# URLs (замените на IP вашего сервера или домен)
NEXT_PUBLIC_APP_URL=http://your-server-ip:3000
NEXT_PUBLIC_API_URL=http://your-server-ip:5001

# API Port
API_PORT=5001

# Security (сгенерируйте случайный ключ: openssl rand -base64 32)
API_SECRET_KEY=your-super-secret-random-key-here

# Node Environment
NODE_ENV=production
```

### Шаг 4: Запуск автоматического деплоя

```bash
# Делаем скрипт исполняемым
chmod +x deploy.sh

# Запускаем деплой
bash deploy.sh
```

Скрипт автоматически:
- Установит Docker и Docker Compose (если нужно)
- Создаст .env файл из шаблона
- Соберет Docker образ
- Запустит контейнеры
- Настроит firewall (UFW)

### Шаг 5: Проверка работы

```bash
# Проверяем статус контейнеров
docker-compose ps

# Смотрим логи
docker-compose logs -f

# Проверяем доступность
curl http://localhost:3000  # UI
curl http://localhost:5001/api/accounts  # API
```

---

## Вариант 2: Ручной Docker Deployment

### Предварительные требования

- Docker и Docker Compose установлены
- VPS/сервер с минимум 2GB RAM
- Открытые порты: 3000, 5001 (или только 80, 443 если используете Nginx)

### Шаги деплоя

#### 1. Подготовка сервера

```bash
# Подключаемся к серверу
ssh user@your-server.com

# Устанавливаем Docker (если еще не установлен)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Устанавливаем Docker Compose
sudo apt-get update
sudo apt-get install docker-compose-plugin
```

#### 2. Клонирование проекта

```bash
# Клонируем репозиторий
git clone <your-repo-url> wa-manager
cd wa-manager
```

#### 3. Настройка переменных окружения

```bash
# Копируем пример
cp .env.production .env

# Редактируем .env
nano .env
```

Обновите следующие переменные:

```env
# Database (твои настройки Supabase)
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# URLs (обновить на реальные)
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_API_URL=https://your-domain.com:4000

# Security (сгенерировать сильный ключ)
API_SECRET_KEY=your-super-secure-random-key-here
```

#### 4. Запуск Docker

```bash
# Собираем и запускаем контейнеры
docker-compose up -d

# Проверяем логи
docker-compose logs -f

# Проверяем статус
docker-compose ps
```

#### 5. Проверка работы

```bash
# UI
curl http://localhost:3000

# API
curl http://localhost:5001/api/accounts
```

#### 6. Настройка Nginx (для HTTPS)

```bash
# Устанавливаем Nginx
sudo apt-get install nginx certbot python3-certbot-nginx

# Создаем конфиг
sudo nano /etc/nginx/sites-available/wa-manager
```

Конфигурация Nginx:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 100M;

    # Next.js UI
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WhatsApp API
    location /api {
        proxy_pass http://localhost:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# Активируем конфиг
sudo ln -s /etc/nginx/sites-available/wa-manager /etc/nginx/sites-enabled/

# Получаем SSL сертификат
sudo certbot --nginx -d your-domain.com

# Перезапускаем Nginx
sudo nginx -t
sudo systemctl restart nginx
```

#### 7. Обновление приложения

```bash
# Останавливаем контейнеры
docker-compose down

# Получаем последние изменения
git pull

# Пересобираем и запускаем
docker-compose up -d --build
```

---

## Вариант 2: Vercel (только UI) + VPS (API)

### Part A: Деплой API на VPS

#### 1. Подключаемся к серверу

```bash
ssh user@your-server.com
```

#### 2. Установка Node.js

```bash
# Устанавливаем Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Устанавливаем PM2
sudo npm install -g pm2
```

#### 3. Клонирование и настройка

```bash
# Клонируем проект
git clone <your-repo-url> wa-manager
cd wa-manager

# Устанавливаем зависимости
npm install

# Копируем и настраиваем .env
cp .env.production .env
nano .env
```

#### 4. Генерация Prisma

```bash
npx prisma generate
npx prisma db push
```

#### 5. Запуск с PM2

```bash
# Запускаем только API сервер
pm2 start server/index.js --name wa-api

# Сохраняем конфигурацию PM2
pm2 save
pm2 startup
```

#### 6. Настройка Nginx для API

```nginx
server {
    listen 443 ssl;
    server_name api.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # CORS headers
        add_header 'Access-Control-Allow-Origin' 'https://your-vercel-app.vercel.app';
        add_header 'Access-Control-Allow-Methods' 'GET, POST, DELETE, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'Content-Type';
    }
}
```

### Part B: Деплой UI на Vercel

#### 1. Подготовка проекта

Убедись, что в репозитории есть:
- `vercel.json`
- `next.config.ts`
- Все необходимые файлы

#### 2. Деплой через Vercel CLI

```bash
# Устанавливаем Vercel CLI
npm install -g vercel

# Логинимся
vercel login

# Деплоим проект
vercel

# Или для production
vercel --prod
```

#### 3. Настройка переменных окружения в Vercel

Зайди в [Vercel Dashboard](https://vercel.com/dashboard):

1. Выбери свой проект
2. Settings → Environment Variables
3. Добавь переменные:

```
NEXT_PUBLIC_API_URL = https://api.your-domain.com
DATABASE_URL = postgresql://...
DIRECT_URL = postgresql://...
```

#### 4. Или деплой через GitHub

1. Подключи репозиторий к Vercel
2. Vercel автоматически задеплоит при каждом push
3. Настрой переменные окружения в Settings

---

## Управление Docker контейнерами

### Просмотр логов

```bash
# Все логи
docker-compose logs -f

# Только последние 100 строк
docker-compose logs --tail=100
```

### Перезапуск

```bash
# Перезапуск всех сервисов
docker-compose restart

# Перезапуск только одного сервиса
docker-compose restart wa-manager
```

### Остановка

```bash
# Остановка
docker-compose stop

# Остановка и удаление контейнеров
docker-compose down

# Остановка, удаление контейнеров и volumes
docker-compose down -v
```

### Обновление

```bash
# Остановка
docker-compose down

# Обновление кода
git pull

# Пересборка и запуск
docker-compose up -d --build
```

### Очистка

```bash
# Удалить неиспользуемые образы
docker image prune -a

# Удалить все (осторожно!)
docker system prune -a --volumes
```

---

## Мониторинг

### Проверка здоровья

```bash
# Docker
docker-compose ps
docker stats

# PM2
pm2 status
pm2 monit
```

### Просмотр логов

```bash
# Docker
docker-compose logs -f wa-manager

# PM2
pm2 logs wa-api
```

---

## Резервное копирование

### WhatsApp сессии

```bash
# Backup
docker cp wa-manager:/app/.wwebjs_auth ./backup/wwebjs_auth_$(date +%Y%m%d)

# Restore
docker cp ./backup/wwebjs_auth wa-manager:/app/.wwebjs_auth
docker-compose restart
```

### База данных

Supabase автоматически создает бэкапы. Также можно создать вручную:

```bash
# Export
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Import
psql $DATABASE_URL < backup_20241103.sql
```

---

## Решение проблем

### Контейнер не запускается

```bash
# Проверяем логи
docker-compose logs

# Проверяем, не заняты ли порты
sudo lsof -i :3000
sudo lsof -i :5001
```

### WhatsApp не подключается

1. Проверь, что Chromium установлен в контейнере
2. Проверь логи: `docker-compose logs -f`
3. Увеличь память для контейнера в `docker-compose.yml`

### CORS ошибки

Убедись, что в Nginx конфиге API сервера настроены CORS headers для Vercel домена.

---

## Безопасность

### Firewall

```bash
# UFW (Ubuntu)
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw allow 3000  # UI (если без Nginx)
sudo ufw allow 5001  # API (если без Nginx)
sudo ufw enable
```

### SSL/TLS

```bash
# Certbot для автоматического обновления
sudo certbot renew --dry-run
```

### Секреты

- Не коммить `.env` файлы
- Использовать сильные API ключи
- Регулярно менять пароли БД

---

## Масштабирование

### Горизонтальное

Для работы нескольких инстансов:
1. Используй Redis для хранения состояния клиентов
2. Настрой Load Balancer
3. Используй shared storage для `.wwebjs_auth`

### Вертикальное

Увеличь ресурсы в `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0'
      memory: 4G
```

---

## Поддержка

Если возникли проблемы:
1. Проверь логи
2. Проверь переменные окружения
3. Убедись, что все порты открыты
4. Проверь подключение к БД

## Тестирование деплоя

### Локальный тест Docker

```bash
# Собираем локально
docker-compose up --build

# Тестируем API
curl http://localhost:5001/api/accounts

# Тестируем UI
open http://localhost:3000
```

### Тестирование production

```bash
# API health check
curl http://your-server-ip:5001/api/accounts

# UI health check
curl http://your-server-ip:3000
```
