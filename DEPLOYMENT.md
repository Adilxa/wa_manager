# Deployment Guide - Production Server

## Деплой на сервер с Docker Compose

### Предварительные требования

На сервере должны быть установлены:
- Docker
- Docker Compose
- Git

### 1. Клонировать репозиторий

```bash
cd /path/to/your/projects
git clone <your-repo-url> wa_manager
cd wa_manager
```

### 2. Создать .env файл

```bash
cp .env.example .env
nano .env
```

Настроить переменные окружения:

```env
# ============================================
# DATABASE CONFIGURATION
# ============================================
DATABASE_URL="postgresql://postgres:STRONG_PASSWORD_HERE@postgres:5432/wa_manager?schema=public"
DIRECT_URL="postgresql://postgres:STRONG_PASSWORD_HERE@postgres:5432/wa_manager?schema=public"

# ============================================
# REDIS CONFIGURATION (для BullMQ)
# ============================================
# Используй имя сервиса из docker-compose
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=

# ============================================
# NEXT.JS CONFIGURATION
# ============================================
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_API_URL=https://your-domain.com

# ============================================
# API CONFIGURATION
# ============================================
API_PORT=5001

# ============================================
# SECURITY
# ============================================
# Сгенерируй сильный пароль:
# openssl rand -base64 32
API_SECRET_KEY=<результат команды выше>

# ============================================
# ENVIRONMENT
# ============================================
NODE_ENV=production
```

### 3. Запустить Docker Compose

```bash
# Собрать и запустить все сервисы
docker-compose up -d --build

# Проверить статус
docker-compose ps

# Должно быть:
# wa-postgres  - Up (healthy)
# wa-redis     - Up (healthy)  <-- НОВОЕ!
# wa-manager   - Up (healthy)
```

### 4. Применить миграции БД

```bash
# Выполнить внутри контейнера
docker-compose exec wa-manager npx prisma db push

# Или если контейнер ещё не запущен
docker-compose run --rm wa-manager npx prisma db push
```

### 5. Проверить логи

```bash
# Все сервисы
docker-compose logs -f

# Только wa-manager
docker-compose logs -f wa-manager

# Только redis
docker-compose logs -f redis

# Убедись что видишь:
# ✅ Using BullMQ for reliable message queuing
# ✅ BullMQ workers initialized
```

### 6. Проверить что всё работает

```bash
# Health check
curl http://localhost:5001/health

# Queue status
curl http://localhost:5001/api/queues/status

# Должен вернуть:
{
  "contracts": {
    "waiting": 0,
    "active": 0,
    "completed": 0,
    "failed": 0
  },
  "messages": {
    "waiting": 0,
    "active": 0,
    "completed": 0,
    "failed": 0
  }
}
```

## Архитектура с Docker Compose

```
┌─────────────────────────────────────┐
│         Docker Network              │
│                                     │
│  ┌──────────────┐                  │
│  │  wa-postgres │ :5432            │
│  │  (Postgres)  │                  │
│  └──────┬───────┘                  │
│         │                           │
│  ┌──────▼───────┐                  │
│  │   wa-redis   │ :6379            │
│  │   (Redis)    │ ◄────────┐       │
│  └──────────────┘          │       │
│                             │       │
│  ┌─────────────────────────▼─────┐ │
│  │       wa-manager              │ │
│  │  (Next.js + API + Workers)    │ │
│  └─────────────┬───────────────┬─┘ │
│                │               │    │
└────────────────┼───────────────┼────┘
                 │               │
              :3000           :5001
              (UI)            (API)
```

## Проверка Redis соединения

### Подключиться к Redis контейнеру

```bash
docker-compose exec redis redis-cli

# Внутри Redis CLI:
127.0.0.1:6379> PING
PONG

127.0.0.1:6379> INFO server
# ... информация о Redis

127.0.0.1:6379> KEYS bull:*
# Показывает ключи BullMQ (если есть активные контракты)

127.0.0.1:6379> exit
```

### Мониторинг Redis в реальном времени

```bash
# Смотреть все команды в реальном времени
docker-compose exec redis redis-cli MONITOR

# Статистика
docker-compose exec redis redis-cli INFO stats
```

## Управление контейнерами

### Остановить всё

```bash
docker-compose down
```

### Остановить с удалением volumes (ОСТОРОЖНО!)

```bash
# Удалит ВСЕ данные: postgres, redis, baileys sessions!
docker-compose down -v
```

### Перезапустить только один сервис

```bash
# Перезапустить wa-manager (после изменений кода)
docker-compose restart wa-manager

# Перезапустить redis
docker-compose restart redis
```

### Посмотреть логи конкретного сервиса

```bash
docker-compose logs -f redis
docker-compose logs -f postgres
docker-compose logs -f wa-manager
```

### Войти в контейнер

```bash
# Войти в wa-manager
docker-compose exec wa-manager sh

# Войти в redis
docker-compose exec redis sh

# Войти в postgres
docker-compose exec postgres sh
```

## Обновление кода (Deploy новой версии)

```bash
# 1. Остановить контейнеры
docker-compose down

# 2. Получить новый код
git pull origin main

# 3. Пересобрать и запустить
docker-compose up -d --build

# 4. Применить миграции если есть изменения в схеме
docker-compose exec wa-manager npx prisma db push

# 5. Проверить логи
docker-compose logs -f wa-manager
```

## Backup и восстановление

### Backup Redis данных

```bash
# Redis автоматически сохраняет в /data (AOF)
# Скопировать volume на хост
docker cp wa-redis:/data ./redis-backup-$(date +%Y%m%d)

# Или создать snapshot
docker-compose exec redis redis-cli BGSAVE
docker cp wa-redis:/data/dump.rdb ./redis-dump-$(date +%Y%m%d).rdb
```

### Восстановление Redis

```bash
# Остановить redis
docker-compose stop redis

# Скопировать backup
docker cp ./redis-backup wa-redis:/data

# Запустить redis
docker-compose start redis
```

### Backup PostgreSQL

```bash
# Создать dump
docker-compose exec postgres pg_dump -U postgres wa_manager > backup-$(date +%Y%m%d).sql

# Восстановление
cat backup-20240101.sql | docker-compose exec -T postgres psql -U postgres wa_manager
```

## Мониторинг production

### Проверить использование ресурсов

```bash
# Статистика по всем контейнерам
docker stats

# Только wa-manager
docker stats wa-manager

# Только redis
docker stats wa-redis
```

### Логи с timestamp

```bash
docker-compose logs -f --timestamps wa-manager
```

### Проверить очереди

```bash
# API эндпоинт
curl http://localhost:5001/api/queues/status

# Или через Redis CLI
docker-compose exec redis redis-cli
> KEYS bull:contracts:*
> KEYS bull:messages:*
> HGETALL bull:contracts:meta
```

## Troubleshooting

### Redis не запускается

```bash
# Проверить логи
docker-compose logs redis

# Проверить healthcheck
docker-compose ps redis

# Перезапустить
docker-compose restart redis
```

### wa-manager не подключается к Redis

```bash
# Проверить что redis работает
docker-compose exec redis redis-cli PING

# Проверить network
docker network inspect wa_manager_default

# Проверить переменные окружения
docker-compose exec wa-manager env | grep REDIS

# Должно быть:
# REDIS_HOST=redis
# REDIS_PORT=6379
```

### Очистить всё и начать заново

```bash
# ВНИМАНИЕ: Удалит ВСЕ данные!
docker-compose down -v
docker-compose up -d --build
docker-compose exec wa-manager npx prisma db push
```

## Security Best Practices

### 1. Использовать secrets для паролей

Создай `docker-compose.prod.yml`:

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

  redis:
    command: redis-server --requirepass /run/secrets/redis_password
    secrets:
      - redis_password

secrets:
  db_password:
    file: ./secrets/db_password.txt
  redis_password:
    file: ./secrets/redis_password.txt
```

### 2. Ограничить доступ к портам

В `docker-compose.yml` порты postgres и redis закрыты наружу (по умолчанию).
Только wa-manager имеет доступ через Docker network.

### 3. Настроить firewall

```bash
# Разрешить только 3000 и 5001
sudo ufw allow 3000/tcp
sudo ufw allow 5001/tcp
sudo ufw enable
```

### 4. Использовать reverse proxy (nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
    }

    location /api {
        proxy_pass http://localhost:5001;
    }
}
```

## Полезные команды

```bash
# Посмотреть использование дискового пространства
docker system df

# Очистить неиспользуемые ресурсы
docker system prune

# Посмотреть все volumes
docker volume ls

# Инспектировать volume
docker volume inspect wa_manager_redis_data

# Экспорт данных из volume
docker run --rm -v wa_manager_redis_data:/data -v $(pwd):/backup alpine tar czf /backup/redis-data.tar.gz -C /data .
```

## Готово! 🎉

Теперь у тебя:
- ✅ PostgreSQL в Docker
- ✅ Redis в Docker с AOF persistence
- ✅ WA Manager с BullMQ workers
- ✅ Автоматический restart
- ✅ Healthchecks
- ✅ Production-ready setup

Все контейнеры работают в одной Docker network и автоматически находят друг друга по именам сервисов!
