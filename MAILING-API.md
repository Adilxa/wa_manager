# WhatsApp Messaging API

Короткая инструкция для клиентов: как создать WhatsApp-аккаунт, подключить его и отправлять сообщения.

## Base URL

```text
https://ilovesanzhar.click
```

Все запросы отправляются в JSON:

```http
Content-Type: application/json
```

## 1. Создать аккаунт

Создает новый WhatsApp-аккаунт в системе.

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
curl -X POST "https://ilovesanzhar.click/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main WhatsApp",
    "useLimits": true
  }'
```

Ответ:

```json
{
  "id": "account_id",
  "name": "Main WhatsApp",
  "phoneNumber": null,
  "status": "DISCONNECTED",
  "qrCode": null,
  "useLimits": true,
  "createdAt": "2026-05-07T11:00:00.000Z",
  "updatedAt": "2026-05-07T11:00:00.000Z"
}
```

Сохраните `id`. Это `accountId` для следующих запросов.

## 2. Подключить WhatsApp

Запускает подключение WhatsApp-аккаунта.

```http
POST /api/accounts/{accountId}/connect
```

Body не нужен.

Пример:

```bash
curl -X POST "https://ilovesanzhar.click/api/accounts/account_id/connect"
```

Ответ:

```json
{
  "success": true,
  "message": "Client initialization started"
}
```

После этого откройте QR-страницу и отсканируйте QR-код через WhatsApp:

```text
https://ilovesanzhar.click/qr/account_id
```

## 3. Проверить статус аккаунта

Возвращает список всех аккаунтов и их состояние.

```http
GET /api/accounts
```

Пример:

```bash
curl "https://ilovesanzhar.click/api/accounts"
```

Ответ:

```json
[
  {
    "id": "account_id",
    "name": "Main WhatsApp",
    "phoneNumber": "996700123456",
    "status": "CONNECTED",
    "clientStatus": "CONNECTED",
    "hasActiveClient": true,
    "useLimits": true
  }
]
```

Аккаунт готов к отправке сообщений, когда:

```json
{
  "clientStatus": "CONNECTED",
  "hasActiveClient": true
}
```

Возможные статусы:

```text
DISCONNECTED
CONNECTING
QR_READY
AUTHENTICATING
CONNECTED
FAILED
```

## 4. Отправить сообщение

Отправляет сообщение через подключенный WhatsApp-аккаунт.

```http
POST /api/messages/send
```

Body:

```json
{
  "accountId": "account_id",
  "to": "996700123456",
  "message": "Здравствуйте! Это тестовое сообщение."
}
```

Пример:

```bash
curl -X POST "https://ilovesanzhar.click/api/messages/send" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "account_id",
    "to": "996700123456",
    "message": "Здравствуйте! Это тестовое сообщение."
  }'
```

Ответ:

```json
{
  "success": true,
  "queued": true,
  "messageId": "message_id",
  "contractId": "contract_id",
  "recipientId": "recipient_id",
  "jobId": "job_id",
  "queuePosition": 1,
  "queueLength": 1,
  "message": "Message queued for delivery"
}
```

Если `queued=true`, сообщение принято системой и поставлено на отправку.

## 5. Формат номера телефона

Обычный формат:

```text
996700123456
79262555166
```

Можно передавать номер с любыми символами, система оставит только цифры:

```text
+996 (700) 123-456
```

Также поддерживается готовый WhatsApp JID:

```text
996700123456@s.whatsapp.net
```

## 6. Получить историю чатов аккаунта

```http
GET /api/accounts/{accountId}/chats
```

Пример:

```bash
curl "https://ilovesanzhar.click/api/accounts/account_id/chats"
```

Ответ:

```json
{
  "data": [
    {
      "chatId": "996700123456@s.whatsapp.net",
      "contactNumber": "996700123456",
      "contactName": "Client",
      "messages": [],
      "unreadCount": 0,
      "lastMessageTime": "2026-05-07T11:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 1,
    "page": 1,
    "limit": 50,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

Дополнительные query-параметры:

```text
page=1
limit=50
phone=996700
```

Пример с фильтром:

```bash
curl "https://ilovesanzhar.click/api/accounts/account_id/chats?page=1&limit=20&phone=996700"
```

## 7. Получить сообщения одного чата

```http
GET /api/accounts/{accountId}/chats/{chatId}
```

`chatId` должен быть URL-encoded.

Пример:

```bash
curl "https://ilovesanzhar.click/api/accounts/account_id/chats/996700123456%40s.whatsapp.net"
```

Ответ:

```json
[
  {
    "id": "message_id",
    "accountId": "account_id",
    "chatId": "996700123456@s.whatsapp.net",
    "direction": "OUTGOING",
    "message": "Здравствуйте! Это тестовое сообщение.",
    "to": "996700123456",
    "status": "SENT",
    "sentAt": "2026-05-07T11:00:00.000Z"
  }
]
```

## 8. Отправить сообщение в конкретный чат

```http
POST /api/accounts/{accountId}/chats/{chatId}
```

Body:

```json
{
  "message": "Здравствуйте! Повторное сообщение в чат."
}
```

Пример:

```bash
curl -X POST "https://ilovesanzhar.click/api/accounts/account_id/chats/996700123456%40s.whatsapp.net" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Здравствуйте! Повторное сообщение в чат."
  }'
```

Ответ:

```json
{
  "success": true,
  "queued": true,
  "messageId": "message_id",
  "queuePosition": 1,
  "queueLength": 1,
  "message": "Message queued for delivery"
}
```

## 9. Частые ошибки

### Аккаунт не подключен

Ответ:

```json
{
  "error": "Account is connecting. Try again in a few seconds.",
  "status": "CONNECTING"
}
```

Что делать:

1. Проверить статус через `GET /api/accounts`.
2. Дождаться `clientStatus=CONNECTED`.
3. Если нужен QR, открыть `/qr/account_id`.

### Аккаунт не найден

Ответ:

```json
{
  "error": "Account not found"
}
```

Проверьте правильность `accountId`.

### Не заполнены обязательные поля

Ответ:

```json
{
  "error": "Missing required fields"
}
```

Для отправки сообщения обязательны:

```json
{
  "accountId": "account_id",
  "to": "996700123456",
  "message": "Текст сообщения"
}
```

## Минимальный рабочий сценарий

```bash
BASE_URL="https://ilovesanzhar.click"

# 1. Создать аккаунт
curl -X POST "$BASE_URL/api/accounts" \
  -H "Content-Type: application/json" \
  -d '{"name":"Main WhatsApp","useLimits":true}'

# 2. Подключить аккаунт
ACCOUNT_ID="account_id"
curl -X POST "$BASE_URL/api/accounts/$ACCOUNT_ID/connect"

# 3. Открыть QR
# https://ilovesanzhar.click/qr/account_id

# 4. Проверить статус
curl "$BASE_URL/api/accounts"

# 5. Отправить сообщение
curl -X POST "$BASE_URL/api/messages/send" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "'$ACCOUNT_ID'",
    "to": "996700123456",
    "message": "Здравствуйте! Это тестовое сообщение."
  }'
```

