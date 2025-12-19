# Unified Queue System - All Messages via BullMQ

## Проблема которую решили

**Было два разных подхода:**

### 1. Contract Messages (надежно)
```javascript
POST /api/contracts → BullMQ → Redis → Workers
✅ Персистентность
✅ Auto retry
✅ Не теряются при перезапуске
```

### 2. Single Messages (ненадежно)
```javascript
POST /api/messages/send → Map (messageQueues) → processMessageQueue()
❌ Потеря данных при перезапуске
❌ Нет персистентности
❌ Ручная обработка
```

## Решение: Унификация через BullMQ

**Теперь ОБА способа используют BullMQ:**

### Contract Messages
```javascript
POST /api/contracts
  → Contract создается в БД
  → POST /api/contracts/:id/start
  → contractQueue (BullMQ)
  → Contract Worker разбивает на сообщения
  → messageQueue (BullMQ) x 1000
  → Message Worker отправляет каждое
```

### Single Messages (НОВОЕ!)
```javascript
POST /api/messages/send
  → Создает temporary contract (1 recipient)
  → Напрямую в messageQueue (BullMQ) с высоким приоритетом
  → Message Worker отправляет
```

## Как это работает

### 1. Отправка single message

**Request:**
```bash
POST /api/messages/send
{
  "accountId": "clxxx",
  "to": "79991234567",
  "message": "Привет!"
}
```

**Что происходит:**
```javascript
1. Создается temporary Contract:
   - name: "Single message to 79991234567"
   - totalCount: 1
   - recipients: [{phoneNumber, message}]

2. Recipient добавляется в BullMQ messageQueue:
   - priority: 10 (выше чем у contract messages!)
   - contractId: temp contract
   - job сохраняется в Redis

3. Message Worker обрабатывает:
   - Берет из Redis
   - Проверяет rate limits
   - Отправляет с human-like поведением
   - Обновляет статус в БД
```

**Response:**
```json
{
  "success": true,
  "queued": true,
  "contractId": "contract_temp_123",
  "recipientId": "rec_456",
  "jobId": "msg-79991234567",
  "queuePosition": 3,
  "message": "Message queued via BullMQ for reliable delivery"
}
```

### 2. Приоритеты

Single messages имеют **приоритет 10**, contract messages - **приоритет 1** (по умолчанию).

Это значит:
- Single messages отправляются **быстрее**
- Contract messages идут в фоне
- Можно быстро отправить срочное сообщение даже если контракт на 1000 сообщений в процессе

```
Message Queue:
┌─────────────────────────────┐
│ Priority 10: Single msg 1   │ ← Отправится первым
│ Priority 10: Single msg 2   │ ← Отправится вторым
│ Priority 1:  Contract msg 1 │
│ Priority 1:  Contract msg 2 │
│ Priority 1:  Contract msg 3 │
│ ...                         │
└─────────────────────────────┘
```

## Преимущества унификации

### ✅ Reliability

**Было:**
- Single messages → теряются при перезапуске
- Contract messages → сохраняются в Redis

**Стало:**
- ВСЕ сообщения → сохраняются в Redis
- Никаких потерь

### ✅ Consistency

**Было:**
- Два разных кода для обработки
- Два разных механизма retry
- Сложная поддержка

**Стало:**
- Один код в Message Worker
- Одна система retry
- Легко поддерживать

### ✅ Monitoring

**Было:**
```bash
curl /api/queues/status
# Показывает только contract messages
# Single messages в Map - не видно
```

**Стало:**
```bash
curl /api/queues/status
{
  "messages": {
    "waiting": 1003,  // ← ВСЕ сообщения (contract + single)!
    "active": 1
  }
}
```

### ✅ Features

Single messages теперь получают **все фичи** контрактов:
- ✅ Auto retry (3 попытки)
- ✅ Rate limiting
- ✅ Daily limits
- ✅ Human-like поведение
- ✅ Статистика в БД (Contract с 1 recipient)
- ✅ Можно проверить статус через `/api/contracts/:id/stats`

## Использование

### Отправить single message

```bash
curl -X POST http://localhost:5001/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "clxxx",
    "to": "79991234567",
    "message": "Срочное сообщение!"
  }'
```

**Response:**
```json
{
  "success": true,
  "contractId": "contract_temp_abc",
  "jobId": "msg-79991234567",
  "queuePosition": 1
}
```

### Проверить статус

```bash
# Через contract stats
curl http://localhost:5001/api/contracts/contract_temp_abc/stats

# Response:
{
  "status": "COMPLETED",
  "total": 1,
  "success": 1,
  "successPhoneNumbers": [
    {"phoneNumber": "79991234567", "sentAt": "..."}
  ]
}
```

### Мониторинг очередей

```bash
curl http://localhost:5001/api/queues/status

# Response:
{
  "messages": {
    "waiting": 5,    // ← Single + Contract messages
    "active": 1,
    "activeJobs": [
      {
        "phoneNumber": "79991234567",  // ← Single message
        "contractId": "contract_temp_abc",
        "progress": 50
      }
    ]
  }
}
```

## Что удалили

### Старые функции (больше не нужны):

1. ~~`messageQueues` Map~~ - заменен на BullMQ `messageQueue`
2. ~~`enqueueMessage()`~~ - заменен на `messageQueue.add()`
3. ~~`processMessageQueue()`~~ - заменен на Message Worker

### Что оставили:

- ✅ `sendMessageWithHumanBehavior()` - используется в Worker
- ✅ `checkRateLimit()` - используется в Worker
- ✅ `checkDailyLimit()` - используется в Worker
- ✅ `messageCounters` Map - для rest periods

## Миграция со старого кода

Если у тебя был код:

```javascript
// Старый способ
const messageId = enqueueMessage(accountId, to, message);
processMessageQueue(accountId);
```

Замени на:

```javascript
// Новый способ через API
await fetch('/api/messages/send', {
  method: 'POST',
  body: JSON.stringify({ accountId, to, message })
});
```

Или напрямую через BullMQ (если пишешь код в server):

```javascript
const { messageQueue } = require('./queue');

// Создать temporary contract
const contract = await prisma.contract.create({
  data: {
    accountId,
    name: `Single message to ${to}`,
    totalCount: 1,
    pendingCount: 1,
    recipients: {
      create: { phoneNumber: to, message, status: 'PENDING' }
    }
  }
});

// Добавить в очередь
await messageQueue.add(`msg-${to}`, {
  contractId: contract.id,
  recipientId: contract.recipients[0].id,
  accountId,
  phoneNumber: to,
  message
}, {
  priority: 10
});
```

## Тестирование

### 1. Single message через API

```bash
# Отправить
curl -X POST http://localhost:5001/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "clxxx",
    "to": "79991234567",
    "message": "Test!"
  }'

# Проверить очередь
curl http://localhost:5001/api/queues/status

# Логи сервера
docker-compose logs -f wa-manager | grep "Single message"
```

### 2. Проверить приоритеты

```bash
# 1. Создать контракт на 100 сообщений
curl -X POST /api/contracts -d '{...}'
curl -X POST /api/contracts/:id/start

# 2. Отправить single message (должно отправиться первым!)
curl -X POST /api/messages/send -d '{...}'

# 3. Проверить очередь
curl /api/queues/status
# activeJobs[0] должен быть single message!
```

## Итог

Теперь **вся система унифицирована**:
- ✅ Single messages = маленькие контракты (1 recipient)
- ✅ Все через BullMQ
- ✅ Никаких потерь данных
- ✅ Один код для всех сообщений
- ✅ Простой мониторинг

**Больше нет Map-based очередей! Всё в Redis через BullMQ! 🎉**
