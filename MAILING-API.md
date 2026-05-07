# Mailing API

Документация по REST API для полного сценария рассылки: от создания WhatsApp-аккаунта до отправки одиночного сообщения или массовой рассылки.

## Базовые настройки

Production URL:

```text
https://ilovesanzhar.click
```

Локальный API внутри контейнера:

```text
http://localhost:5001
```

Для примеров ниже:

```bash
BASE_URL="https://ilovesanzhar.click"
```

Для реальной отправки WhatsApp должны быть включены клиенты:

```env
ENABLE_WHATSAPP_CLIENTS=true
RESTORE_CONNECTED_CLIENTS=true
RESTORE_CONNECTED_CLIENTS_LIMIT=2
```

Для отправки через BullMQ endpoints (`/api/messages/send`, `/api/contracts/:id/start`) должны быть включены workers:

```env
START_QUEUE_WORKERS=true
```

После изменения `.env.production` перезапусти app:

```bash
docker rm -f wa-manager
docker compose --env-file .env.production up -d wa-manager
```

## 1. Проверить здоровье сервиса

```bash
curl -s "$BASE_URL/health"
```

Успешный ответ:

```json
{
  "status": "ok",
  "activeClients": 2,
  "connectingClients": 0
}
```

Проверить WebSocket:

```bash
curl -s "$BASE_URL/health/websocket"
```

## 2. Создать WhatsApp-аккаунт

Endpoint:

```http
POST /api/accounts
```

Body:

```json
{
  "name": "Main WhatsApp",
  "useLimits": true
}
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main WhatsApp",
    "useLimits": true
  }'
```

Ответ:

```json
{
  "id": "cmo1h2ejn0004qr2ansq3dq57",
  "name": "Main WhatsApp",
  "phoneNumber": null,
  "status": "DISCONNECTED",
  "qrCode": null,
  "useLimits": true,
  "createdAt": "2026-05-07T11:00:00.000Z",
  "updatedAt": "2026-05-07T11:00:00.000Z"
}
```

Сохрани `id`. Дальше он используется как `accountId`.

## 3. Подключить WhatsApp-аккаунт

Endpoint:

```http
POST /api/accounts/:id/connect
```

Body не нужен.

Пример:

```bash
ACCOUNT_ID="cmo1h2ejn0004qr2ansq3dq57"

curl -s -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID/connect"
```

Ответ:

```json
{
  "success": true,
  "message": "Client initialization started"
}
```

После этого аккаунт перейдет в один из статусов:

```text
CONNECTING
QR_READY
AUTHENTICATING
CONNECTED
FAILED
DISCONNECTED
```

Если нужен QR, открой:

```text
https://ilovesanzhar.click/qr/<accountId>
```

## 4. Проверить аккаунты и статус подключения

Endpoint:

```http
GET /api/accounts
```

Пример:

```bash
curl -s "$BASE_URL/api/accounts"
```

Ответ:

```json
[
  {
    "id": "cmo1h2ejn0004qr2ansq3dq57",
    "name": "Main WhatsApp",
    "phoneNumber": "996990559971",
    "status": "CONNECTED",
    "clientStatus": "CONNECTED",
    "hasActiveClient": true,
    "lastHeartbeat": 1778153934267,
    "latency": 3,
    "useLimits": true
  }
]
```

Для отправки важно:

```json
{
  "clientStatus": "CONNECTED",
  "hasActiveClient": true
}
```

Если `hasActiveClient=false`, аккаунт есть в базе, но реальный WhatsApp-клиент не поднят.

## 5. Отправить одно сообщение

Endpoint:

```http
POST /api/messages/send
```

Body:

```json
{
  "accountId": "cmo1h2ejn0004qr2ansq3dq57",
  "to": "996700123456",
  "message": "Здравствуйте! Это тестовое сообщение."
}
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/messages/send" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "cmo1h2ejn0004qr2ansq3dq57",
    "to": "996700123456",
    "message": "Здравствуйте! Это тестовое сообщение."
  }'
```

Ответ:

```json
{
  "success": true,
  "queued": true,
  "messageId": "contract_id",
  "contractId": "contract_id",
  "recipientId": "recipient_id",
  "jobId": "123",
  "queuePosition": 1,
  "queueLength": 1,
  "message": "Message queued for delivery"
}
```

Номер можно передавать цифрами:

```text
996700123456
79262555166
```

Также поддерживаются готовые WhatsApp JID:

```text
996700123456@s.whatsapp.net
120363000000000000@g.us
```

## 6. Создать массовую рассылку

Endpoint:

```http
POST /api/contracts
```

Body:

```json
{
  "accountId": "cmo1h2ejn0004qr2ansq3dq57",
  "name": "Рассылка клиентам 2026-05-07",
  "recipients": [
    {
      "phoneNumber": "996700123456",
      "message": "Здравствуйте! У нас новое предложение."
    },
    {
      "phoneNumber": "996700654321",
      "message": "Здравствуйте! У нас новое предложение."
    }
  ]
}
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/contracts" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "cmo1h2ejn0004qr2ansq3dq57",
    "name": "Рассылка клиентам 2026-05-07",
    "recipients": [
      {
        "phoneNumber": "996700123456",
        "message": "Здравствуйте! У нас новое предложение."
      },
      {
        "phoneNumber": "996700654321",
        "message": "Здравствуйте! У нас новое предложение."
      }
    ]
  }'
```

Ответ:

```json
{
  "id": "contract_id",
  "accountId": "cmo1h2ejn0004qr2ansq3dq57",
  "name": "Рассылка клиентам 2026-05-07",
  "totalCount": 2,
  "successCount": 0,
  "failureCount": 0,
  "pendingCount": 2,
  "status": "PENDING",
  "recipients": [
    {
      "id": "recipient_id",
      "phoneNumber": "996700123456",
      "message": "Здравствуйте! У нас новое предложение.",
      "status": "PENDING"
    }
  ]
}
```

Сохрани `id`. Дальше он используется как `contractId`.

## 7. Запустить массовую рассылку

Endpoint:

```http
POST /api/contracts/:id/start
```

Body не нужен.

Пример:

```bash
CONTRACT_ID="contract_id"

curl -s -X POST "$BASE_URL/api/contracts/$CONTRACT_ID/start"
```

Ответ:

```json
{
  "success": true,
  "message": "Contract queued",
  "contractId": "contract_id",
  "jobId": "contract-contract_id",
  "pendingRecipients": 2
}
```

Если ответ:

```json
{
  "error": "Account not connected"
}
```

Сначала проверь аккаунт:

```bash
curl -s "$BASE_URL/api/accounts"
```

Нужны `clientStatus=CONNECTED` и `hasActiveClient=true`.

## 8. Проверить статус рассылки

Получить список рассылок:

```bash
curl -s "$BASE_URL/api/contracts?accountId=$ACCOUNT_ID"
```

Получить одну рассылку:

```bash
curl -s "$BASE_URL/api/contracts/$CONTRACT_ID"
```

Получить статистику:

```bash
curl -s "$BASE_URL/api/contracts/$CONTRACT_ID/stats"
```

Ответ статистики:

```json
{
  "contractId": "contract_id",
  "name": "Рассылка клиентам 2026-05-07",
  "status": "IN_PROGRESS",
  "total": 100,
  "success": 35,
  "failed": 2,
  "pending": 63,
  "successRate": "35.00%"
}
```

Статусы рассылки:

```text
PENDING
IN_PROGRESS
PAUSED
COMPLETED
FAILED
```

Статусы получателей:

```text
PENDING
QUEUED
SENDING
SUCCESS
FAILED
```

## 9. Поставить рассылку на паузу

Endpoint:

```http
POST /api/contracts/:id/pause
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/contracts/$CONTRACT_ID/pause"
```

Ответ:

```json
{
  "success": true,
  "message": "Contract paused"
}
```

## 10. Проверить очереди

Endpoint:

```http
GET /api/queues/status
```

Пример:

```bash
curl -s "$BASE_URL/api/queues/status"
```

Ответ:

```json
{
  "contracts": {
    "waiting": 0,
    "active": 0,
    "completed": 1,
    "failed": 0
  },
  "messages": {
    "waiting": 10,
    "active": 1,
    "completed": 25,
    "failed": 2
  }
}
```

## 11. Получить очередь конкретного аккаунта

Endpoint:

```http
GET /api/accounts/:id/queue
```

Пример:

```bash
curl -s "$BASE_URL/api/accounts/$ACCOUNT_ID/queue"
```

Ответ:

```json
{
  "accountId": "cmo1h2ejn0004qr2ansq3dq57",
  "queueLength": 0,
  "status": {
    "clientStatus": "CONNECTED",
    "isResting": false,
    "messagesSinceRest": 3
  },
  "limits": {
    "dailyCount": 12,
    "dailyLimit": 1000
  }
}
```

## 12. Обновить аккаунт

Endpoint:

```http
PUT /api/accounts/:id
```

Body:

```json
{
  "name": "Main WhatsApp Updated",
  "useLimits": false
}
```

Пример:

```bash
curl -s -X PUT "$BASE_URL/api/accounts/$ACCOUNT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main WhatsApp Updated",
    "useLimits": false
  }'
```

`useLimits=true` включает мягкие лимиты и задержки. Для боевой рассылки лучше оставлять `true`.

## 13. Отключить аккаунт

Endpoint:

```http
POST /api/accounts/:id/disconnect
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID/disconnect"
```

## 14. Сбросить сессию аккаунта

Используй только если QR/сессия сломались.

Endpoint:

```http
POST /api/accounts/:id/reset-session
```

Пример:

```bash
curl -s -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID/reset-session"
```

После reset нужно снова вызвать `/connect` и отсканировать QR.

## 15. Удалить аккаунт

Endpoint:

```http
DELETE /api/accounts/:id
```

Пример:

```bash
curl -s -X DELETE "$BASE_URL/api/accounts/$ACCOUNT_ID"
```

## Полный минимальный flow

```bash
BASE_URL="https://ilovesanzhar.click"

# 1. Create account
curl -s -X POST "$BASE_URL/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{"name":"Main WhatsApp","useLimits":true}'

# 2. Connect account
ACCOUNT_ID="paste_account_id_here"
curl -s -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID/connect"

# 3. Check status
curl -s "$BASE_URL/api/accounts"

# 4. Create mailing contract
curl -s -X POST "$BASE_URL/api/contracts" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "'$ACCOUNT_ID'",
    "name": "Test mailing",
    "recipients": [
      {
        "phoneNumber": "996700123456",
        "message": "Здравствуйте! Тестовая рассылка."
      }
    ]
  }'

# 5. Start mailing
CONTRACT_ID="paste_contract_id_here"
curl -s -X POST "$BASE_URL/api/contracts/$CONTRACT_ID/start"

# 6. Check stats
curl -s "$BASE_URL/api/contracts/$CONTRACT_ID/stats"
```

## Частые ошибки

### `WhatsApp client initialization is disabled`

В `.env.production` должно быть:

```env
ENABLE_WHATSAPP_CLIENTS=true
```

После изменения перезапусти контейнер.

### `Account not connected`

Аккаунт не поднят как активный клиент. Проверь:

```bash
curl -s "$BASE_URL/api/accounts"
```

Нужны:

```json
{
  "clientStatus": "CONNECTED",
  "hasActiveClient": true
}
```

### Сообщения попали в очередь, но не отправляются

Для BullMQ endpoints включи workers:

```env
START_QUEUE_WORKERS=true
```

Потом:

```bash
docker rm -f wa-manager
docker compose --env-file .env.production up -d wa-manager
```

### VPS начинает грузиться

Проверить:

```bash
docker stats --no-stream
```

Если CPU высокий, снизь количество одновременно восстанавливаемых клиентов:

```env
RESTORE_CONNECTED_CLIENTS_LIMIT=2
```

