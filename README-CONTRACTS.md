# WhatsApp Contract System - Массовая рассылка

## Что это?

Production-ready система для массовой рассылки WhatsApp сообщений с:
- ✅ **Контракты** - пакеты из 1000+ сообщений
- ✅ **BullMQ + Redis** - надежные очереди (не теряются при перезапуске!)
- ✅ **Автоматический rate limiting** - защита от бана WhatsApp
- ✅ **Статистика** - списки успешных/неудачных номеров
- ✅ **Docker-ready** - всё в одной команде

## Быстрый старт на сервере

```bash
# 1. Создать .env
cp .env.example .env
nano .env  # Настрой DATABASE_URL и API_SECRET_KEY

# 2. Запустить всё (PostgreSQL + Redis + WA Manager)
docker-compose up -d

# 3. Применить миграции
docker-compose exec wa-manager npx prisma db push

# 4. Проверить что работает
curl http://localhost:5001/health
curl http://localhost:5001/api/queues/status
```

**Готово!** Теперь можешь создавать контракты.

## Использование

### 1. Создать контракт

```bash
curl -X POST http://your-server:5001/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "YOUR_ACCOUNT_ID",
    "name": "Рассылка на 1000 человек",
    "recipients": [
      {"phoneNumber": "79991234567", "message": "Привет! ..."},
      {"phoneNumber": "79997654321", "message": "Привет! ..."}
    ]
  }'
```

**Response:**
```json
{
  "id": "contract_xxx",
  "totalCount": 1000,
  "status": "PENDING"
}
```

### 2. Запустить обработку

```bash
curl -X POST http://your-server:5001/api/contracts/contract_xxx/start
```

Система автоматически:
- Добавит все сообщения в BullMQ очередь (Redis)
- Будет отправлять с rate limiting (20 сообщений/минуту)
- Делать перерывы после каждых 5 сообщений
- Использовать human-like поведение (typing, задержки)
- Считать success/failure

### 3. Получить статистику

```bash
curl http://your-server:5001/api/contracts/contract_xxx/stats
```

**Response:**
```json
{
  "status": "COMPLETED",
  "total": 1000,
  "success": 950,
  "failed": 50,
  "successRate": "95.00%",

  "successPhoneNumbers": [
    {"phoneNumber": "79991234567", "sentAt": "2024-01-01T00:00:00.000Z"},
    {"phoneNumber": "79997654321", "sentAt": "2024-01-01T00:01:00.000Z"}
  ],

  "failedPhoneNumbers": [
    {"phoneNumber": "79990000000", "errorMessage": "Invalid number", "attempts": 3}
  ]
}
```

## Мониторинг

### Статус очередей

```bash
curl http://your-server:5001/api/queues/status
```

```json
{
  "contracts": {
    "waiting": 2,      // Ждут обработки
    "active": 1,       // Обрабатываются сейчас
    "completed": 5,    // Завершены
    "failed": 0        // Упали с ошибкой
  },
  "messages": {
    "waiting": 850,    // Ждут отправки
    "active": 1,       // Отправляется сейчас
    "completed": 150   // Уже отправлены
  }
}
```

### Логи

```bash
# Все логи
docker-compose logs -f wa-manager

# Только ошибки
docker-compose logs -f wa-manager | grep ERROR

# Redis логи
docker-compose logs -f redis
```

## Docker Compose архитектура

```yaml
services:
  postgres:       # PostgreSQL БД
  redis:          # Redis для BullMQ очередей
  wa-manager:     # Next.js UI + API + Workers
```

Все сервисы в одной Docker network, находят друг друга по именам:
- `postgres:5432`
- `redis:6379`

## Почему BullMQ + Redis?

**Старая версия (Map):**
- ❌ Потеря данных при перезапуске
- ❌ Нет персистентности
- ❌ Невозможен scaling

**Новая версия (BullMQ + Redis):**
- ✅ Все сохраняется в Redis (AOF persistence)
- ✅ Восстановление после перезапуска
- ✅ Автоматические retry (3 попытки)
- ✅ Можно запустить несколько workers
- ✅ Production tested

**Пример:**
```
Сервер упал на 3000-м сообщении из 10000
├─ Map: ❌ Потеряно 7000 сообщений
└─ BullMQ: ✅ Продолжит с 3001-го после перезапуска
```

## Управление

### Приостановить контракт

```bash
curl -X POST http://your-server:5001/api/contracts/contract_xxx/pause
```

### Возобновить контракт

```bash
curl -X POST http://your-server:5001/api/contracts/contract_xxx/start
```

### Удалить контракт

```bash
curl -X DELETE http://your-server:5001/api/contracts/contract_xxx
```

### Получить все контракты

```bash
curl http://your-server:5001/api/contracts

# Фильтр по аккаунту
curl http://your-server:5001/api/contracts?accountId=xxx

# Фильтр по статусу
curl http://your-server:5001/api/contracts?status=IN_PROGRESS
```

## Обновление на сервере

```bash
# 1. Остановить
docker-compose down

# 2. Получить новый код
git pull origin main

# 3. Пересобрать и запустить
docker-compose up -d --build

# 4. Миграции (если нужны)
docker-compose exec wa-manager npx prisma db push
```

**Важно:** Redis данные не теряются! Все активные контракты продолжат работу.

## Защита от бана WhatsApp

Система автоматически:
1. **Rate limit**: Не более 20 сообщений/минуту
2. **Daily limit**: 500-1000 сообщений/день (зависит от возраста аккаунта)
3. **Перерывы**: После каждых 5 сообщений отдых 30-120 сек
4. **Human-like**:
   - Случайные задержки (0.5-2 сек)
   - Typing indicators
   - Эмуляция времени печати
   - Случайные паузы между сообщениями (3-8 сек)

### Отключить лимиты (на свой риск!)

```bash
curl -X PUT http://your-server:5001/api/accounts/ACCOUNT_ID \
  -H "Content-Type: application/json" \
  -d '{"useLimits": false}'
```

## Документация

- **CONTRACT-API.md** - полная документация API (все эндпоинты)
- **BULLMQ-SETUP.md** - как работает BullMQ, production setup
- **DEPLOYMENT.md** - деплой на сервер, troubleshooting
- **RELIABILITY-COMPARISON.md** - почему BullMQ лучше Map
- **QUICK-START.md** - быстрый старт для тестирования

## Troubleshooting

### Контракт застрял в IN_PROGRESS

```bash
# Проверить очереди
curl http://your-server:5001/api/queues/status

# Перезапустить контракт
curl -X POST http://your-server:5001/api/contracts/contract_xxx/pause
curl -X POST http://your-server:5001/api/contracts/contract_xxx/start
```

### Redis не работает

```bash
# Проверить контейнер
docker-compose ps redis

# Логи
docker-compose logs redis

# Перезапустить
docker-compose restart redis

# Подключиться к Redis
docker-compose exec redis redis-cli
> PING
PONG
```

### Много FAILED сообщений

Проверь номера телефонов:
- Должны быть в формате `79991234567` (без +)
- Валидные WhatsApp номера
- Аккаунт подключен и активен

### Очистить failed jobs

```bash
docker-compose exec redis redis-cli
> DEL bull:messages:failed
> DEL bull:contracts:failed
```

## API Endpoints

| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/contracts` | Создать контракт |
| GET | `/api/contracts` | Получить все контракты |
| GET | `/api/contracts/:id` | Детали контракта |
| GET | `/api/contracts/:id/stats` | Статистика с номерами |
| POST | `/api/contracts/:id/start` | Запустить/возобновить |
| POST | `/api/contracts/:id/pause` | Приостановить |
| DELETE | `/api/contracts/:id` | Удалить |
| GET | `/api/queues/status` | Статус очередей BullMQ |

## Переменные окружения

```env
# Docker Compose (по умолчанию)
REDIS_HOST=redis         # Имя сервиса из docker-compose.yml
REDIS_PORT=6379
REDIS_PASSWORD=          # Пустой если не настроен

# Локальная разработка
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

## Готово! 🚀

Теперь у тебя production-ready система для массовой рассылки:
- Никаких потерь данных
- Автоматическая защита от бана
- Полная статистика
- Простой деплой через Docker

**Вопросы?** Читай полную документацию в других MD файлах!
