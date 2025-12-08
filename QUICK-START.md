# Quick Start - Contract System

## Быстрый старт для тестирования

### 1. Запустить Redis (Docker - самый простой способ)

```bash
docker run -d -p 6379:6379 --name redis redis:latest
```

Или установить локально: https://redis.io/docs/install/

### 2. Установить зависимости

```bash
npm install
```

### 3. Применить миграции

```bash
npx prisma db push
```

### 4. Запустить сервер

```bash
npm run dev:server
```

### 5. Создать контракт и отправить сообщения

```bash
# 1. Создать аккаунт
curl -X POST http://localhost:5001/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Account", "useLimits": false}'

# Сохрани ACCOUNT_ID из ответа

# 2. Подключить аккаунт
curl -X POST http://localhost:5001/api/accounts/ACCOUNT_ID/connect

# 3. Отсканировать QR код
# Открой: http://localhost:3000/qr/ACCOUNT_ID

# 4. Создать контракт
curl -X POST http://localhost:5001/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "ACCOUNT_ID",
    "name": "Тестовая рассылка",
    "recipients": [
      {"phoneNumber": "79991234567", "message": "Привет! Тест 1"},
      {"phoneNumber": "79997654321", "message": "Привет! Тест 2"}
    ]
  }'

# Сохрани CONTRACT_ID из ответа

# 5. Запустить контракт
curl -X POST http://localhost:5001/api/contracts/CONTRACT_ID/start

# 6. Проверить статистику
curl http://localhost:5001/api/contracts/CONTRACT_ID/stats

# 7. Мониторинг очередей
curl http://localhost:5001/api/queues/status
```

## Проверка что все работает

```bash
# Статус очередей
curl http://localhost:5001/api/queues/status

# Должен вернуть:
{
  "contracts": {
    "waiting": 0,
    "active": 1,
    "completed": 0
  },
  "messages": {
    "waiting": 2,
    "active": 1,
    "completed": 0
  }
}
```

## Основные команды

```bash
# Получить все контракты
curl http://localhost:5001/api/contracts

# Получить детали контракта
curl http://localhost:5001/api/contracts/CONTRACT_ID

# Получить статистику (с номерами телефонов)
curl http://localhost:5001/api/contracts/CONTRACT_ID/stats

# Приостановить контракт
curl -X POST http://localhost:5001/api/contracts/CONTRACT_ID/pause

# Возобновить контракт
curl -X POST http://localhost:5001/api/contracts/CONTRACT_ID/start

# Удалить контракт
curl -X DELETE http://localhost:5001/api/contracts/CONTRACT_ID
```

## Результат

После завершения в статистике увидишь:

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

## Что дальше?

- Читай `CONTRACT-API.md` - полная документация API
- Читай `BULLMQ-SETUP.md` - как работает BullMQ и production setup
- Настрой лимиты в `server/index.js` (CONFIG)
