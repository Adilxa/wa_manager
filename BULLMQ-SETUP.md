# BullMQ Setup - Production-Ready Queue System

Система контрактов теперь использует **BullMQ** вместо in-memory Map для максимальной надежности и масштабируемости.

## Почему BullMQ лучше чем Map?

### Проблемы с Map:
- ❌ Данные теряются при перезапуске сервера
- ❌ Нет персистентности
- ❌ Не работает с несколькими инстансами (scaling)
- ❌ Нет автоматических retry механизмов
- ❌ Нет приоритетов и rate limiting на уровне очереди

### Преимущества BullMQ:
- ✅ **Персистентность** - все задачи сохраняются в Redis
- ✅ **Восстановление после перезапуска** - контракты продолжаются с места остановки
- ✅ **Horizontal scaling** - можно запустить несколько workers
- ✅ **Автоматические retry** - повторная отправка failed сообщений
- ✅ **Rate limiting** - встроенный rate limiter
- ✅ **Мониторинг** - детальная статистика очередей
- ✅ **Priority queues** - можно задавать приоритеты контрактам
- ✅ **Delayed jobs** - можно отложить выполнение
- ✅ **Production tested** - используется в тысячах проектов

## Установка

### 1. Установить Redis

#### Рекомендуется: Docker Compose (уже настроен!)

Redis уже добавлен в `docker-compose.yml`. Просто запусти:

```bash
docker-compose up -d
```

Это запустит:
- ✅ PostgreSQL (контейнер: wa-postgres)
- ✅ Redis (контейнер: wa-redis)
- ✅ WA Manager (контейнер: wa-manager)

Redis настроен с:
- Имя контейнера: `wa-redis`
- Внутренний порт: 6379
- Persistence: AOF (appendonly yes)
- Healthcheck: автоматический

#### Альтернатива: Установка локально

На Ubuntu/Debian:
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

На macOS:
```bash
brew install redis
brew services start redis
```

На Windows:
Скачайте Redis for Windows: https://github.com/microsoftarchive/redis/releases

#### Альтернатива: Standalone Docker

```bash
docker run -d -p 6379:6379 --name wa-redis redis:7-alpine
```

### 2. Установить зависимости Node.js

```bash
npm install
```

Это установит:
- `bullmq` - библиотека для работы с очередями
- `ioredis` - Redis клиент для Node.js

### 3. Настроить переменные окружения

Создайте `.env` из `.env.example`:

```bash
cp .env.example .env
```

Для Docker Compose (уже настроено):
```env
# Redis Configuration (для Docker Compose)
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
```

Для локальной разработки:
```env
# Redis Configuration (локально)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

### 4. Применить миграции базы данных

```bash
npx prisma db push
```

### 5. Запустить сервер

```bash
npm run dev:server
```

## Как это работает

### Архитектура

```
┌─────────────────┐
│   API Request   │
│  POST /start    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Contract Queue  │  ◄── BullMQ Queue в Redis
│  (1 contract)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Contract Worker │  ◄── Разбивает контракт
│   (5 workers)   │      на individual messages
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Message Queue   │  ◄── BullMQ Queue в Redis
│ (1000 messages) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Message Worker  │  ◄── Отправляет сообщения
│   (1 worker)    │      с rate limiting
└─────────────────┘
```

### Два типа очередей:

1. **Contract Queue** - для контрактов
   - Concurrency: 5 (обрабатывает до 5 контрактов параллельно)
   - Разбивает контракт на individual messages

2. **Message Queue** - для сообщений
   - Concurrency: 1 (по 1 сообщению за раз)
   - Rate limiting: 20 сообщений/минуту
   - Автоматические retry при ошибках

## API Endpoints

### Создать и запустить контракт

```bash
# 1. Создать контракт
curl -X POST http://localhost:5001/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "your_account_id",
    "name": "Рассылка на 1000 человек",
    "recipients": [
      {"phoneNumber": "79991234567", "message": "Привет!"},
      {"phoneNumber": "79997654321", "message": "Привет!"}
    ]
  }'

# 2. Запустить контракт (добавляет в BullMQ queue)
curl -X POST http://localhost:5001/api/contracts/CONTRACT_ID/start
```

### Мониторинг очередей

```bash
# Получить статистику очередей
curl http://localhost:5001/api/queues/status
```

Response:
```json
{
  "contracts": {
    "waiting": 2,
    "active": 1,
    "completed": 5,
    "failed": 0,
    "delayed": 0,
    "activeJobs": [
      {
        "id": "contract-xxx",
        "data": {"contractId": "xxx"},
        "progress": 50,
        "attemptsMade": 1
      }
    ]
  },
  "messages": {
    "waiting": 850,
    "active": 1,
    "completed": 150,
    "failed": 5,
    "delayed": 0,
    "activeJobs": [...]
  }
}
```

### Приостановить контракт

```bash
curl -X POST http://localhost:5001/api/contracts/CONTRACT_ID/pause
```

Это:
1. Обновляет статус контракта в БД
2. Удаляет pending jobs из очереди
3. Текущие активные jobs завершатся

### Удалить контракт

```bash
curl -X DELETE http://localhost:5001/api/contracts/CONTRACT_ID
```

## Преимущества в production

### 1. Восстановление после сбоя

Если сервер упал:
```bash
# Перезапускаем сервер
npm run dev:server
```

BullMQ автоматически:
- Загрузит все pending jobs из Redis
- Продолжит обработку с места остановки
- Повторит failed jobs (до 3 раз)

### 2. Horizontal Scaling

Можно запустить несколько инстансов сервера:

```bash
# Terminal 1
PORT=5001 npm run dev:server

# Terminal 2
PORT=5002 npm run dev:server

# Terminal 3
PORT=5003 npm run dev:server
```

Все workers будут работать с одной Redis очередью и автоматически распределять нагрузку!

### 3. Monitoring с BullBoard (опционально)

Установить Bull Board для веб-интерфейса:

```bash
npm install @bull-board/express @bull-board/api
```

Добавить в `server/index.js`:

```javascript
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(contractQueue),
    new BullMQAdapter(messageQueue)
  ],
  serverAdapter
});

app.use('/admin/queues', serverAdapter.getRouter());
```

Теперь можно открыть: http://localhost:5001/admin/queues

## Настройка для production

### Увеличить concurrency

В `server/workers.js`:

```javascript
// Больше contract workers для параллельной обработки
concurrency: 10, // вместо 5

// Message worker должен остаться 1 для соблюдения rate limits
concurrency: 1,
```

### Настроить Redis для production

`/etc/redis/redis.conf`:

```conf
# Включить AOF persistence
appendonly yes
appendfsync everysec

# Увеличить max memory
maxmemory 2gb
maxmemory-policy allkeys-lru

# Включить password
requirepass your_strong_password
```

### Добавить мониторинг

Используйте Redis Insight или RedisInsight для мониторинга:
- https://redis.com/redis-enterprise/redis-insight/

## Troubleshooting

### Redis не запускается

```bash
# Проверить статус
sudo systemctl status redis

# Посмотреть логи
sudo journalctl -u redis

# Перезапустить
sudo systemctl restart redis
```

### Очередь не обрабатывается

```bash
# Проверить статус очередей
curl http://localhost:5001/api/queues/status

# Проверить логи сервера
tail -f logs/server.log
```

### Очистить все очереди

```bash
# Подключиться к Redis
redis-cli

# Очистить все данные (ОСТОРОЖНО!)
FLUSHALL

# Или удалить конкретные ключи
DEL bull:contracts:*
DEL bull:messages:*
```

### Удалить failed jobs

В `server/index.js` добавить endpoint:

```javascript
app.post("/api/queues/clean", async (req, res) => {
  await contractQueue.clean(0, 1000, 'failed');
  await messageQueue.clean(0, 10000, 'failed');
  res.json({ success: true });
});
```

## Сравнение: Map vs BullMQ

| Функция | Map | BullMQ |
|---------|-----|--------|
| Персистентность | ❌ | ✅ Redis |
| Восстановление после перезапуска | ❌ | ✅ |
| Horizontal scaling | ❌ | ✅ |
| Auto retry | ❌ | ✅ 3 попытки |
| Rate limiting | Кастомный | ✅ Встроенный |
| Мониторинг | ❌ | ✅ Bull Board |
| Priority queues | ❌ | ✅ |
| Delayed jobs | ❌ | ✅ |
| Production готовность | ❌ | ✅ |

## Заключение

BullMQ делает систему контрактов **production-ready**:
- Никаких потерь данных при перезапуске
- Автоматическое восстановление
- Возможность масштабирования
- Надежная обработка с retry механизмами

Это **правильный** подход для production системы массовой рассылки!
