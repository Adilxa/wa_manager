# WhatsApp Manager API: REST и WebSocket

Документация составлена по текущему коду проекта `server/index.js`, `server/workers.js`, `prisma/schema.prisma`, `test-socket.js` и проверке production-домена.

Production base URL:

```text
https://ilovesanzhar.click
```

Локальный API сервер:

```text
http://localhost:5001
```

Формат данных: JSON. Авторизация в текущем Express API не реализована: заголовок `Authorization` разрешен CORS, но сервер его не проверяет.

## Важное про WebSocket

В текущем коде репозитория WebSocket/Socket.IO сервер не подключен:

- в `package.json` нет зависимости `socket.io`;
- в `server/index.js` нет `Server` из `socket.io`, namespace `/chats`, событий `join`, `message:send`, `chat:message:*`;
- production `GET https://ilovesanzhar.click/socket.io/?EIO=4&transport=polling` возвращает `404 page not found`;
- production `HEAD https://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket` возвращает `400`.

Поэтому REST API ниже является фактическим рабочим контрактом текущего проекта. WebSocket-раздел в конце описывает legacy/ожидаемый Socket.IO контракт из `SOCKET-POSTMAN-GUIDE.md` и `test-socket.js`; для его работы нужно добавить Socket.IO сервер в backend и проксирование `/socket.io` в Nginx.

## Общие правила REST

### Заголовки

```http
Content-Type: application/json
Accept: application/json
```

### Успешные ответы

Обычно сервер возвращает JSON-объект или массив. Создание ресурсов возвращает `201`, постановка сообщения в очередь возвращает `202`.

### Ошибки

Типовой формат:

```json
{
  "error": "Account not found"
}
```

В некоторых случаях добавляются поля:

```json
{
  "error": "Failed to connect account. Please connect manually first.",
  "details": "Connection error"
}
```

### Основные HTTP-коды

| Код | Когда используется |
| --- | --- |
| `200` | Запрос успешно выполнен |
| `201` | Ресурс создан |
| `202` | Сообщение принято в очередь |
| `400` | Неверный запрос, не хватает полей, аккаунт не подключен, ресурс в неподходящем статусе |
| `404` | Аккаунт, клиент или контракт не найден |
| `500` | Внутренняя ошибка сервера |
| `503` | Аккаунт не готов к отправке или автоподключение не удалось |

## Статусы и модели

### AccountStatus

| Статус | Значение |
| --- | --- |
| `DISCONNECTED` | Аккаунт не подключен |
| `CONNECTING` | Запущена инициализация клиента |
| `QR_READY` | QR-код создан и готов к сканированию |
| `AUTHENTICATING` | WhatsApp Web проходит авторизацию |
| `CONNECTED` | Аккаунт подключен |
| `FAILED` | Ошибка подключения/инициализации |

### MessageDirection

| Статус | Значение |
| --- | --- |
| `INCOMING` | Входящее сообщение |
| `OUTGOING` | Исходящее сообщение |

### MessageStatus

| Статус | Значение |
| --- | --- |
| `PENDING` | Ожидает обработки |
| `SENT` | Отправлено |
| `RECEIVED` | Получено входящее сообщение |
| `DELIVERED` | Доставлено |
| `READ` | Прочитано |
| `FAILED` | Ошибка отправки |

### ContractStatus

| Статус | Значение |
| --- | --- |
| `PENDING` | Контракт создан, но не запущен |
| `IN_PROGRESS` | Контракт обрабатывается |
| `PAUSED` | Контракт приостановлен |
| `COMPLETED` | Все получатели обработаны |
| `FAILED` | Критическая ошибка обработки |

### RecipientStatus

| Статус | Значение |
| --- | --- |
| `PENDING` | Получатель ожидает отправки |
| `QUEUED` | Сообщение добавлено в очередь |
| `SENDING` | Сообщение отправляется сейчас |
| `SUCCESS` | Сообщение успешно отправлено |
| `FAILED` | Сообщение не отправлено |

## REST: Health и очереди

### GET /health

Возвращает состояние API процесса, подключенных клиентов, память и reconnect-счетчики.

```bash
curl https://ilovesanzhar.click/health
```

Успешный ответ:

```json
{
  "status": "ok",
  "uptime": 12345,
  "uptimeFormatted": "3h 25m 45s",
  "timestamp": "2026-05-04T18:00:00.000Z",
  "activeClients": 1,
  "connectingClients": 0,
  "clients": [
    {
      "accountId": "cm...",
      "status": "CONNECTED",
      "hasPhone": true,
      "lastHeartbeat": "2026-05-04T18:00:00.000Z",
      "latency": 120,
      "lastActivity": "2026-05-04T17:59:50.000Z"
    }
  ],
  "memory": {
    "heapUsed": 120,
    "heapTotal": 180,
    "heapPercent": 67,
    "rss": 350
  },
  "reconnections": {}
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Health JSON |

Примечание: на момент проверки `https://ilovesanzhar.click/health` возвращал `Bad Gateway`, хотя `/api/queues/status` отвечал успешно. Это похоже на проблему production-проксирования или health route.

### GET /api/queues/status

Возвращает состояние BullMQ очередей `contracts` и `messages`.

```bash
curl https://ilovesanzhar.click/api/queues/status
```

Успешный ответ:

```json
{
  "contracts": {
    "waiting": 0,
    "active": 0,
    "completed": 0,
    "failed": 0,
    "delayed": 0,
    "activeJobs": []
  },
  "messages": {
    "waiting": 0,
    "active": 0,
    "completed": 1,
    "failed": 0,
    "delayed": 0,
    "activeJobs": [
      {
        "id": "123",
        "phoneNumber": "996500353529",
        "contractId": "cm...",
        "progress": 0,
        "attemptsMade": 0
      }
    ]
  }
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Статус очередей |
| `500` | `{ "error": "..." }` |

## REST: Аккаунты WhatsApp

### GET /api/accounts

Получить все WhatsApp-аккаунты.

```bash
curl https://ilovesanzhar.click/api/accounts
```

Успешный ответ:

```json
[
  {
    "id": "cm...",
    "name": "Main account",
    "phoneNumber": "996500000000",
    "status": "CONNECTED",
    "qrCode": null,
    "useLimits": true,
    "createdAt": "2026-05-04T18:00:00.000Z",
    "updatedAt": "2026-05-04T18:00:00.000Z",
    "clientStatus": "CONNECTED",
    "hasActiveClient": true,
    "lastHeartbeat": 1777917600000,
    "latency": 123
  }
]
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Массив аккаунтов |
| `500` | `{ "error": "..." }` |

### POST /api/accounts

Создать аккаунт.

```bash
curl -X POST https://ilovesanzhar.click/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"Client WhatsApp","useLimits":true}'
```

Тело запроса:

```json
{
  "name": "Client WhatsApp",
  "useLimits": true
}
```

Поля:

| Поле | Тип | Обязательно | Описание |
| --- | --- | --- | --- |
| `name` | string | да фактически, но сервер явно не валидирует | Имя аккаунта |
| `useLimits` | boolean | нет | `true` по умолчанию. Включает лимиты и human-like задержки |

Успешный ответ `201`:

```json
{
  "id": "cm...",
  "name": "Client WhatsApp",
  "phoneNumber": null,
  "status": "DISCONNECTED",
  "qrCode": null,
  "useLimits": true,
  "createdAt": "2026-05-04T18:00:00.000Z",
  "updatedAt": "2026-05-04T18:00:00.000Z"
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `201` | Аккаунт создан |
| `500` | Ошибка Prisma/БД, например отсутствует обязательное поле `name` |

### GET /api/accounts/:id

Получить один аккаунт.

```bash
curl https://ilovesanzhar.click/api/accounts/cm123
```

Успешный ответ `200`:

```json
{
  "id": "cm123",
  "name": "Client WhatsApp",
  "phoneNumber": "996500000000",
  "status": "CONNECTED",
  "qrCode": null,
  "useLimits": true,
  "createdAt": "2026-05-04T18:00:00.000Z",
  "updatedAt": "2026-05-04T18:00:00.000Z",
  "clientStatus": "CONNECTED",
  "hasActiveClient": true,
  "lastHeartbeat": 1777917600000,
  "latency": 123
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Аккаунт найден |
| `404` | `{ "error": "Account not found" }` |
| `500` | `{ "error": "..." }` |

### PUT /api/accounts/:id

Обновить `name` и/или `useLimits`.

```bash
curl -X PUT https://ilovesanzhar.click/api/accounts/cm123 \
  -H "Content-Type: application/json" \
  -d '{"name":"New name","useLimits":false}'
```

Тело запроса:

```json
{
  "name": "New name",
  "useLimits": false
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Обновленный аккаунт |
| `500` | Ошибка Prisma/БД, включая несуществующий `id` |

Примечание: если аккаунт не найден, код сейчас вернет `500`, а не `404`.

### POST /api/accounts/:id/connect

Запустить подключение аккаунта. Сервер создает/использует Baileys session, меняет статусы и генерирует QR.

```bash
curl -X POST https://ilovesanzhar.click/api/accounts/cm123/connect
```

Успешный ответ `200`:

```json
{
  "success": true,
  "message": "Client initialization started"
}
```

После этого нужно опрашивать `GET /api/accounts/:id`, пока:

- `clientStatus = QR_READY`: можно показать `qrCode`;
- `clientStatus = CONNECTED`: аккаунт подключен;
- `clientStatus = FAILED`: подключение не удалось.

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Инициализация началась |
| `400` | `{ "error": "Client is already being initialized" }` |
| `400` | `{ "error": "Client already connected" }` |
| `500` | `{ "error": "Account not found" }` или другая ошибка инициализации |

### POST /api/accounts/:id/disconnect

Отключить активный WhatsApp клиент.

```bash
curl -X POST https://ilovesanzhar.click/api/accounts/cm123/disconnect
```

Успешный ответ:

```json
{
  "success": true
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Клиент отключен |
| `404` | `{ "error": "Client not found" }` |
| `500` | `{ "error": "..." }` |

### POST /api/accounts/:id/reset-session

Сбросить Baileys session, удалить локальные auth-файлы аккаунта и перевести статус в `DISCONNECTED`.

```bash
curl -X POST https://ilovesanzhar.click/api/accounts/cm123/reset-session
```

Успешный ответ:

```json
{
  "success": true,
  "message": "Session reset successfully. You can now reconnect with a new QR code."
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Session сброшена |
| `500` | `{ "error": "Failed to reset session" }` |

### DELETE /api/accounts/:id

Удалить аккаунт, его session-файлы, очереди, лимиты, сообщения и контракты через cascade relations.

```bash
curl -X DELETE https://ilovesanzhar.click/api/accounts/cm123
```

Успешный ответ:

```json
{
  "success": true,
  "message": "Account deleted successfully",
  "accountId": "cm123"
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Аккаунт удален |
| `404` | `{ "error": "Account not found" }` |
| `500` | `{ "error": "...", "details": "..." }` |

## REST: Сообщения

### POST /api/messages/send

Поставить одиночное сообщение в надежную BullMQ очередь. Сервер создает временный `Contract` на одного получателя, добавляет job в очередь `messages` и возвращает `202`.

```bash
curl -X POST https://ilovesanzhar.click/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{"accountId":"cm123","to":"996500353529","message":"hi dear"}'
```

Тело запроса:

```json
{
  "accountId": "cm123",
  "to": "996500353529",
  "message": "hi dear"
}
```

Поля:

| Поле | Тип | Обязательно | Описание |
| --- | --- | --- | --- |
| `accountId` | string | да | ID WhatsApp аккаунта |
| `to` | string | да | Номер получателя. Если нет `@`, backend отправит на `${to}@s.whatsapp.net` |
| `message` | string | да | Текст сообщения |

Успешный ответ `202`:

```json
{
  "success": true,
  "queued": true,
  "messageId": "cm_contract_id",
  "contractId": "cm_contract_id",
  "recipientId": "cm_recipient_id",
  "jobId": "123",
  "queuePosition": 1,
  "queueLength": 1,
  "message": "Message queued via BullMQ for reliable delivery",
  "status": "CONNECTED",
  "dailyCount": 0,
  "dailyLimit": 500
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `202` | Сообщение принято в очередь |
| `400` | `{ "error": "Missing required fields" }` |
| `404` | `{ "error": "Account not found" }` |
| `503` | `{ "error": "Account is connecting. Please wait and try again in a few seconds.", "status": "QR_READY" }` |
| `503` | `{ "error": "Failed to connect account. Please connect manually first.", "details": "..." }` |
| `500` | `{ "error": "..." }` |

Поведение:

- если клиент не подключен, сервер пробует автоподключение;
- если через 2 секунды аккаунт не стал `CONNECTED`, возвращает `503`;
- сообщение отправляется worker-ом асинхронно;
- фактический результат отправки нужно смотреть через контракт/статистику или чаты.

## REST: Чаты

### GET /api/accounts/:id/chats

Получить список чатов аккаунта, собранный из таблицы `messages`.

```bash
curl "https://ilovesanzhar.click/api/accounts/cm123/chats?page=1&limit=50&phone=996"
```

Query-параметры:

| Параметр | Тип | По умолчанию | Описание |
| --- | --- | --- | --- |
| `page` | number | `1` | Номер страницы |
| `limit` | number | `50` | Размер страницы |
| `phone` | string | нет | Фильтр по `to`, `from`, `contactNumber` через contains |

Успешный ответ:

```json
{
  "data": [
    {
      "chatId": "996500353529@s.whatsapp.net",
      "contactNumber": "996500353529",
      "contactName": "Sanjar",
      "messages": [
        {
          "id": "cm_msg",
          "accountId": "cm123",
          "chatId": "996500353529@s.whatsapp.net",
          "direction": "INCOMING",
          "message": "hello",
          "to": null,
          "from": "996500353529",
          "status": "RECEIVED",
          "contactName": "Sanjar",
          "contactNumber": "996500353529",
          "sentAt": "2026-05-04T18:00:00.000Z",
          "updatedAt": "2026-05-04T18:00:00.000Z"
        }
      ],
      "unreadCount": 0,
      "lastMessageTime": "2026-05-04T18:00:00.000Z"
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

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Список чатов |
| `500` | `{ "error": "..." }` |

Примечание: `unreadCount` сейчас всегда `0`, явного учета прочитанных входящих в коде нет.

### GET /api/accounts/:accountId/chats/:chatId

Получить сообщения конкретного чата. `chatId` нужно URL-encode.

```bash
curl "https://ilovesanzhar.click/api/accounts/cm123/chats/996500353529%40s.whatsapp.net"
```

Успешный ответ:

```json
[
  {
    "id": "cm_msg",
    "accountId": "cm123",
    "chatId": "996500353529@s.whatsapp.net",
    "direction": "OUTGOING",
    "message": "hi dear",
    "to": "996500353529",
    "from": null,
    "status": "SENT",
    "contactName": null,
    "contactNumber": "996500353529",
    "sentAt": "2026-05-04T18:00:00.000Z",
    "updatedAt": "2026-05-04T18:00:00.000Z"
  }
]
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Массив сообщений, может быть пустым |
| `500` | `{ "error": "..." }` |

### POST /api/accounts/:accountId/chats/:chatId

Поставить сообщение в legacy in-memory очередь конкретного аккаунта. В отличие от `/api/messages/send`, этот endpoint не использует BullMQ.

```bash
curl -X POST "https://ilovesanzhar.click/api/accounts/cm123/chats/996500353529%40s.whatsapp.net" \
  -H "Content-Type: application/json" \
  -d '{"message":"hi dear"}'
```

Тело запроса:

```json
{
  "message": "hi dear"
}
```

Успешный ответ `202`:

```json
{
  "success": true,
  "queued": true,
  "messageId": "1777917600000-abc123xyz",
  "queuePosition": 1,
  "queueLength": 1,
  "message": "Message queued for automatic delivery",
  "status": "CONNECTED",
  "dailyCount": 0,
  "dailyLimit": 500
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `202` | Сообщение добавлено в in-memory очередь |
| `400` | `{ "error": "Message is required" }` |
| `404` | `{ "error": "Account not found" }` |
| `503` | Аккаунт подключается или не удалось автоподключение |
| `500` | `{ "error": "...", "success": false }` |

### GET /api/accounts/:id/queue

Получить состояние legacy in-memory очереди аккаунта.

```bash
curl https://ilovesanzhar.click/api/accounts/cm123/queue
```

Успешный ответ:

```json
{
  "accountId": "cm123",
  "queueLength": 1,
  "messages": [
    {
      "position": 1,
      "to": "996500353529",
      "message": "hi dear",
      "retries": 0,
      "createdAt": "2026-05-04T18:00:00.000Z"
    }
  ],
  "status": {
    "clientStatus": "CONNECTED",
    "isResting": false,
    "messagesSinceRest": 0,
    "restThreshold": 5
  },
  "limits": {
    "dailyCount": 0,
    "dailyLimit": 500,
    "isNewAccount": true
  }
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Состояние очереди |
| `500` | `{ "error": "..." }` |

## REST: Контракты и массовая рассылка

### POST /api/contracts

Создать контракт массовой рассылки.

```bash
curl -X POST https://ilovesanzhar.click/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "cm123",
    "name": "Рассылка акции",
    "recipients": [
      { "phoneNumber": "996500353529", "message": "Первое сообщение" },
      { "phoneNumber": "996700000000", "message": "Второе сообщение" }
    ]
  }'
```

Тело запроса:

```json
{
  "accountId": "cm123",
  "name": "Рассылка акции",
  "recipients": [
    {
      "phoneNumber": "996500353529",
      "message": "Первое сообщение"
    }
  ]
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `201` | Контракт создан |
| `400` | `{ "error": "Missing required fields" }` |
| `400` | `{ "error": "Recipients array cannot be empty" }` |
| `400` | `{ "error": "Each recipient must have phoneNumber and message" }` |
| `404` | `{ "error": "Account not found" }` |
| `500` | `{ "error": "..." }` |

Успешный ответ `201`:

```json
{
  "id": "cm_contract",
  "accountId": "cm123",
  "name": "Рассылка акции",
  "totalCount": 1,
  "successCount": 0,
  "failureCount": 0,
  "pendingCount": 1,
  "status": "PENDING",
  "createdAt": "2026-05-04T18:00:00.000Z",
  "updatedAt": "2026-05-04T18:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "recipients": [
    {
      "id": "cm_recipient",
      "contractId": "cm_contract",
      "phoneNumber": "996500353529",
      "message": "Первое сообщение",
      "status": "PENDING",
      "attempts": 0,
      "lastAttempt": null,
      "errorMessage": null,
      "messageId": null,
      "sentAt": null,
      "createdAt": "2026-05-04T18:00:00.000Z",
      "updatedAt": "2026-05-04T18:00:00.000Z"
    }
  ]
}
```

### GET /api/contracts

Получить список контрактов.

```bash
curl "https://ilovesanzhar.click/api/contracts?accountId=cm123&status=IN_PROGRESS"
```

Query-параметры:

| Параметр | Тип | Описание |
| --- | --- | --- |
| `accountId` | string | Фильтр по аккаунту |
| `status` | string | `PENDING`, `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `FAILED` |

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Массив контрактов |
| `500` | `{ "error": "..." }` |

### GET /api/contracts/:id

Получить контракт с аккаунтом и получателями.

```bash
curl https://ilovesanzhar.click/api/contracts/cm_contract
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Контракт найден |
| `404` | `{ "error": "Contract not found" }` |
| `500` | `{ "error": "..." }` |

### POST /api/contracts/:id/start

Запустить или возобновить контракт. Сервер добавляет job в очередь `contracts`, а worker раскладывает получателей в очередь `messages`.

```bash
curl -X POST https://ilovesanzhar.click/api/contracts/cm_contract/start
```

Успешный ответ:

```json
{
  "success": true,
  "message": "Contract queued for processing",
  "contractId": "cm_contract",
  "jobId": "contract-cm_contract",
  "pendingRecipients": 10
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Контракт добавлен в очередь |
| `400` | `{ "error": "Contract already completed" }` |
| `400` | `{ "error": "No pending recipients to process" }` |
| `400` | `{ "error": "Account not connected" }` |
| `404` | `{ "error": "Contract not found" }` |
| `500` | `{ "error": "..." }` |

### POST /api/contracts/:id/pause

Приостановить контракт в статусе `IN_PROGRESS` и удалить pending job `contract-${id}` из очереди.

```bash
curl -X POST https://ilovesanzhar.click/api/contracts/cm_contract/pause
```

Успешный ответ:

```json
{
  "success": true,
  "message": "Contract paused"
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Контракт поставлен на паузу |
| `400` | `{ "error": "Contract is not in progress" }` |
| `404` | `{ "error": "Contract not found" }` |
| `500` | `{ "error": "..." }` |

Важно: уже активное сообщение в `messages` queue может успеть отправиться, пауза прежде всего останавливает контрактный job и дальнейшую обработку.

### GET /api/contracts/:id/stats

Получить статистику контракта и списки номеров по результатам.

```bash
curl https://ilovesanzhar.click/api/contracts/cm_contract/stats
```

Успешный ответ:

```json
{
  "contractId": "cm_contract",
  "name": "Рассылка акции",
  "status": "COMPLETED",
  "total": 100,
  "success": 95,
  "failed": 5,
  "pending": 0,
  "successRate": "95.00%",
  "successPhoneNumbers": [
    {
      "phoneNumber": "996500353529",
      "sentAt": "2026-05-04T18:00:00.000Z"
    }
  ],
  "failedPhoneNumbers": [
    {
      "phoneNumber": "996700000000",
      "errorMessage": "Client not connected",
      "attempts": 3
    }
  ],
  "pendingPhoneNumbers": [
    {
      "phoneNumber": "996555000000",
      "status": "QUEUED"
    }
  ],
  "duration": "120s",
  "createdAt": "2026-05-04T18:00:00.000Z",
  "startedAt": "2026-05-04T18:01:00.000Z",
  "completedAt": "2026-05-04T18:03:00.000Z"
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Статистика |
| `404` | `{ "error": "Contract not found" }` |
| `500` | `{ "error": "..." }` |

### DELETE /api/contracts/:id

Удалить контракт и всех recipients. Если есть job `contract-${id}`, он удаляется из очереди.

```bash
curl -X DELETE https://ilovesanzhar.click/api/contracts/cm_contract
```

Успешный ответ:

```json
{
  "success": true
}
```

Кейсы:

| Код | Ответ |
| --- | --- |
| `200` | Контракт удален |
| `404` | `{ "error": "Contract not found" }` |
| `500` | `{ "error": "..." }` |

## Лимиты и поведение отправки

Если у аккаунта `useLimits: true`, применяются защитные ограничения:

| Настройка | Значение |
| --- | --- |
| Rate limit | 20 сообщений в минуту |
| Daily limit для новых аккаунтов младше 7 дней | 500 сообщений в день |
| Daily limit для старых аккаунтов | 1000 сообщений в день |
| Отдых после сообщений | после каждых 5 сообщений |
| Длительность отдыха | 30-120 секунд |
| Задержка перед typing | 0.5-2 секунды |
| Скорость печати | 30-100 мс на символ |
| Задержка между сообщениями | 3-8 секунд |

Если `useLimits: false`, сообщение отправляется без human-like задержек, но BullMQ retry/backoff все равно работает.

BullMQ настройки:

| Очередь | Attempts | Backoff | Особенности |
| --- | --- | --- | --- |
| `contracts` | 3 | exponential, 5000 ms | добавляет recipients в `messages` |
| `messages` | 3 | exponential, 2000 ms | отправляет конкретное сообщение |

## Рекомендуемые сценарии интеграции REST

### Подключение нового WhatsApp аккаунта

1. `POST /api/accounts` с `name` и `useLimits`.
2. `POST /api/accounts/:id/connect`.
3. Каждые 3-5 секунд вызывать `GET /api/accounts/:id`.
4. Когда `clientStatus = QR_READY`, показать `qrCode` пользователю.
5. Когда `clientStatus = CONNECTED`, можно отправлять сообщения.
6. Если `FAILED`, вызвать `POST /api/accounts/:id/reset-session`, затем снова `connect`.

### Одиночная отправка

1. Проверить `GET /api/accounts/:id`, что `clientStatus = CONNECTED`.
2. Вызвать `POST /api/messages/send`.
3. Получить `contractId`/`recipientId`.
4. Проверять `GET /api/contracts/:contractId/stats` или `GET /api/contracts/:contractId`.

### Массовая отправка

1. Создать контракт через `POST /api/contracts`.
2. Проверить, что аккаунт подключен.
3. Запустить `POST /api/contracts/:id/start`.
4. Мониторить `GET /api/contracts/:id/stats` и `GET /api/queues/status`.
5. Для остановки использовать `POST /api/contracts/:id/pause`.
6. Для удаления использовать `DELETE /api/contracts/:id`.

### Работа с чатами

1. Получить список `GET /api/accounts/:id/chats`.
2. Открыть чат `GET /api/accounts/:accountId/chats/:chatId`.
3. Отправить ответ через `POST /api/accounts/:accountId/chats/:chatId`.

## WebSocket / Socket.IO legacy contract

Этот раздел описывает контракт, который указан в `SOCKET-POSTMAN-GUIDE.md` и `test-socket.js`, но не реализован в текущем backend-коде. Использовать его в production можно только после добавления Socket.IO сервера.

### URL

Socket.IO namespace:

```text
wss://ilovesanzhar.click/chats
```

Raw Engine.IO URL для Postman:

```text
wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket
```

### Подключение через socket.io-client

```javascript
const { io } = require("socket.io-client");

const socket = io("https://ilovesanzhar.click/chats", {
  transports: ["websocket"],
  reconnection: true
});
```

### Событие: join

Подписывает socket на комнату аккаунта, чтобы получать события только по этому аккаунту.

Client emit:

```javascript
socket.emit("join", "cm_account_id");
```

Ожидаемое поведение сервера:

- добавить socket в room `account:${accountId}`;
- после join отправлять клиенту события `chat:message:new`, `chat:message:sent`, `chat:message:failed`.

### Событие: message:send

Отправить сообщение через WebSocket. Рекомендуется использовать ACK callback.

Client emit:

```javascript
socket.emit(
  "message:send",
  {
    "accountId": "cm_account_id",
    "to": "996500353529",
    "message": "hi dear"
  },
  (response) => {
    console.log(response);
  }
);
```

Ожидаемый ACK успеха:

```json
{
  "success": true,
  "queued": true,
  "messageId": "1777917600000-abc123xyz",
  "queuePosition": 1,
  "message": "Message queued for delivery"
}
```

Ожидаемый ACK ошибки:

```json
{
  "success": false,
  "error": "Missing required fields"
}
```

Рекомендуемые ошибки:

| Кейc | ACK |
| --- | --- |
| Нет `accountId`, `to` или `message` | `{ "success": false, "error": "Missing required fields" }` |
| Аккаунт не найден | `{ "success": false, "error": "Account not found" }` |
| Аккаунт не подключен | `{ "success": false, "error": "Account not connected" }` |
| Серверная ошибка | `{ "success": false, "error": "..." }` |

### Broadcast: chat:message:new

Новое входящее или исходящее сообщение.

Server emit:

```javascript
socket.emit("chat:message:new", {
  "accountId": "cm_account_id",
  "chatId": "996500353529@s.whatsapp.net",
  "message": {
    "id": "cm_msg",
    "direction": "INCOMING",
    "message": "hello",
    "from": "996500353529",
    "to": null,
    "status": "RECEIVED",
    "contactName": "Sanjar",
    "contactNumber": "996500353529",
    "sentAt": "2026-05-04T18:00:00.000Z"
  }
});
```

### Broadcast: chat:message:sent

Сообщение успешно отправлено.

Server emit:

```json
{
  "accountId": "cm_account_id",
  "messageId": "cm_msg",
  "chatId": "996500353529@s.whatsapp.net",
  "to": "996500353529",
  "status": "sent",
  "timestamp": "2026-05-04T18:00:00.000Z"
}
```

### Broadcast: chat:message:failed

Сообщение не отправлено.

Server emit:

```json
{
  "accountId": "cm_account_id",
  "messageId": "cm_msg",
  "chatId": "996500353529@s.whatsapp.net",
  "to": "996500353529",
  "status": "failed",
  "error": "Client not connected",
  "timestamp": "2026-05-04T18:00:00.000Z"
}
```

### Raw WebSocket последовательность для Postman

1. Подключиться:

```text
wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket
```

2. Ожидаемый handshake:

```text
0{"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}
```

3. Подключиться к namespace:

```text
40/chats
```

4. Ожидаемый ответ:

```text
40/chats{"sid":"..."}
```

5. Join room:

```text
42/chats,["join","cm_account_id"]
```

6. Отправить сообщение с callback ID `1`:

```text
42/chats,1["message:send",{"accountId":"cm_account_id","to":"996500353529","message":"hi dear"}]
```

7. Ожидаемый ACK:

```text
43/chats,1[{"success":true,"queued":true,"messageId":"...","queuePosition":1,"message":"Message queued for delivery"}]
```

8. Ожидаемый broadcast после отправки:

```text
42/chats,["chat:message:sent",{"accountId":"cm_account_id","messageId":"...","status":"sent","timestamp":"2026-05-04T18:00:00.000Z"}]
```

Важно: без callback ID Postman не получит ACK. Сообщение вида ниже отправляет event, но не просит callback:

```text
42/chats,["message:send",{"accountId":"cm_account_id","to":"996500353529","message":"hi dear"}]
```

### Что нужно реализовать для рабочего WebSocket

Минимальная backend-логика:

1. Установить зависимости `socket.io` и `socket.io-client` для тестов.
2. Обернуть Express server в Socket.IO server.
3. Создать namespace `/chats`.
4. Реализовать `join(accountId)` с room `account:${accountId}`.
5. Реализовать `message:send` через ту же бизнес-логику, что `POST /api/messages/send`.
6. В `messages.upsert` Baileys отправлять `chat:message:new`.
7. После успешной отправки worker-ом отправлять `chat:message:sent`.
8. После ошибки worker-ом отправлять `chat:message:failed`.
9. В Nginx добавить прокси для `/socket.io/` на API server с Upgrade headers.

Пример Nginx location:

```nginx
location /socket.io/ {
    proxy_pass http://localhost:5001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

## Production-проверка

Проверка выполнена при локальной дате 2026-05-05 в часовом поясе Asia/Bishkek. HTTP-заголовок `Date` от домена на момент проверки был 2026-05-04 UTC.

Команды:

```bash
curl -s https://ilovesanzhar.click/api/queues/status
curl -s https://ilovesanzhar.click/health
curl -s "https://ilovesanzhar.click/socket.io/?EIO=4&transport=polling"
curl -I "https://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket"
```

Наблюдения:

| URL | Результат |
| --- | --- |
| `/api/queues/status` | JSON от API, endpoint работает |
| `/health` | `Bad Gateway` |
| `/socket.io/?EIO=4&transport=polling` | `404 page not found` |
| `/socket.io/?EIO=4&transport=websocket` | `400` на HEAD |

Вывод: REST API частично доступен на домене, WebSocket endpoint на текущем production-домене не подтвержден как рабочий.
