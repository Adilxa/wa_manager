# WebSocket / Socket.IO raw protocol

Документ для ручного подключения через Postman или другой raw WebSocket клиент.

Production URL:

```text
wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket
```

Namespace:

```text
/chats
```

Важно: это не обычный JSON WebSocket. Сервер ожидает формат Socket.IO поверх Engine.IO, поэтому сообщения выглядят как `40/chats`, `42/chats,...`, `43/chats,...`.

## Полная последовательность

### 1. Подключиться к WebSocket

URL:

```text
wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket
```

После подключения сервер должен прислать handshake:

```text
0{"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}
```

Что это значит:

| Поле | Значение |
| --- | --- |
| `0` | Engine.IO open packet |
| `sid` | ID сессии |
| `pingInterval` | как часто сервер ожидает ping/pong |
| `pingTimeout` | таймаут соединения |

### 2. Подключиться к namespace `/chats`

Отправить:

```text
40/chats
```

Ожидаемый ответ:

```text
40/chats{"sid":"..."}
```

Что это значит:

| Часть | Значение |
| --- | --- |
| `40` | Socket.IO connect packet |
| `/chats` | namespace для чатов |

### 3. Присоединиться к комнате аккаунта

Отправить:

```text
42/chats,["join","cmnxk4zgs0001ms2992ixarnq"]
```

Где `cmnxk4zgs0001ms2992ixarnq` - это `accountId`.

Зачем нужен `join`:

- сервер подписывает соединение на комнату конкретного WhatsApp аккаунта;
- после этого клиент должен получать broadcast события по этому аккаунту;
- без `join` можно получить ACK на отправку, но не получить события `chat:message:sent`, `chat:message:new`, `chat:message:failed`.

### 4. Отправить сообщение с callback ID

Отправить:

```text
42/chats,1["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]
```

Важно: цифра `1` после запятой - это ID callback. По нему сервер вернет ACK.

Структура пакета:

```text
42/chats,1["message:send",{"accountId":"...","to":"...","message":"..."}]
│ │      │ │
│ │      │ └─ payload события: [eventName, data]
│ │      └─── callback ID
│ └────────── namespace
└──────────── Socket.IO event packet
```

Тело события:

```json
{
  "accountId": "cmnxk4zgs0001ms2992ixarnq",
  "to": "996500353529",
  "message": "hi dear"
}
```

Поля:

| Поле | Тип | Обязательно | Описание |
| --- | --- | --- | --- |
| `accountId` | string | да | ID WhatsApp аккаунта |
| `to` | string | да | Номер получателя без `+` |
| `message` | string | да | Текст сообщения |

### 5. Получить ACK ответ

Если сообщение принято в очередь, сервер должен вернуть:

```text
43/chats,1[{"success":true,"queued":true,"messageId":"...","queuePosition":1,"message":"Message queued for delivery"}]
```

Что это значит:

| Часть | Значение |
| --- | --- |
| `43` | Socket.IO ACK packet |
| `/chats` | namespace |
| `1` | тот же callback ID, который был в запросе |
| JSON внутри `[...]` | ответ обработчика `message:send` |

Расшифрованный JSON:

```json
{
  "success": true,
  "queued": true,
  "messageId": "...",
  "queuePosition": 1,
  "message": "Message queued for delivery"
}
```

## Почему без callback ID нет ответа

Неправильно:

```text
42/chats,["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]
```

Такой пакет отправляет событие, но не просит сервер вернуть ACK. Поэтому Postman может ничего не показать сразу после отправки.

Правильно:

```text
42/chats,1["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]
```

Здесь `1` - callback ID. Можно использовать `1`, `2`, `3` и так далее. Ответ придет с тем же ID:

```text
43/chats,1[...]
43/chats,2[...]
43/chats,3[...]
```

## Broadcast события

ACK означает только то, что сервер принял сообщение в очередь. Фактический результат отправки приходит отдельным событием.

### chat:message:sent

Сообщение успешно отправлено:

```text
42/chats,["chat:message:sent",{"accountId":"cmnxk4zgs0001ms2992ixarnq","messageId":"...","status":"sent","timestamp":"2026-05-05T00:00:00.000Z"}]
```

JSON:

```json
{
  "accountId": "cmnxk4zgs0001ms2992ixarnq",
  "messageId": "...",
  "status": "sent",
  "timestamp": "2026-05-05T00:00:00.000Z"
}
```

### chat:message:failed

Сообщение не отправлено:

```text
42/chats,["chat:message:failed",{"accountId":"cmnxk4zgs0001ms2992ixarnq","messageId":"...","status":"failed","error":"Client not connected","timestamp":"2026-05-05T00:00:00.000Z"}]
```

JSON:

```json
{
  "accountId": "cmnxk4zgs0001ms2992ixarnq",
  "messageId": "...",
  "status": "failed",
  "error": "Client not connected",
  "timestamp": "2026-05-05T00:00:00.000Z"
}
```

### chat:message:new

Новое входящее или исходящее сообщение:

```text
42/chats,["chat:message:new",{"accountId":"cmnxk4zgs0001ms2992ixarnq","chatId":"996500353529@s.whatsapp.net","message":{"id":"...","direction":"INCOMING","message":"hello","from":"996500353529","status":"RECEIVED"}}]
```

JSON:

```json
{
  "accountId": "cmnxk4zgs0001ms2992ixarnq",
  "chatId": "996500353529@s.whatsapp.net",
  "message": {
    "id": "...",
    "direction": "INCOMING",
    "message": "hello",
    "from": "996500353529",
    "to": null,
    "status": "RECEIVED"
  }
}
```

## Типовые ошибки ACK

Если сервер не может принять сообщение, ожидаемый ACK:

```text
43/chats,1[{"success":false,"error":"Missing required fields"}]
```

Варианты:

| Кейc | Ответ |
| --- | --- |
| Не передан `accountId`, `to` или `message` | `{ "success": false, "error": "Missing required fields" }` |
| Аккаунт не найден | `{ "success": false, "error": "Account not found" }` |
| Аккаунт не подключен | `{ "success": false, "error": "Account not connected" }` |
| Серверная ошибка | `{ "success": false, "error": "..." }` |

## Ping / Pong

Socket.IO/Engine.IO соединение использует heartbeat. Если raw клиент получает ping packet:

```text
2
```

нужно ответить pong packet:

```text
3
```

Если не отвечать на ping, сервер закроет соединение по `pingTimeout`.

## Короткая шпаргалка

```text
1. Connect:
   wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket

2. Server:
   0{"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":60000}

3. Client:
   40/chats

4. Server:
   40/chats{"sid":"..."}

5. Client:
   42/chats,["join","cmnxk4zgs0001ms2992ixarnq"]

6. Client:
   42/chats,1["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]

7. Server ACK:
   43/chats,1[{"success":true,"queued":true,"messageId":"...","queuePosition":1,"message":"Message queued for delivery"}]

8. Server broadcast:
   42/chats,["chat:message:sent",{"accountId":"cmnxk4zgs0001ms2992ixarnq","messageId":"...","status":"sent","timestamp":"..."}]
```

## Примечание по текущему проекту

В текущем backend-коде этого репозитория Socket.IO сервер не найден. REST API реализован в `server/index.js`, но namespace `/chats` и события `join`, `message:send`, `chat:message:*` нужно добавить отдельно, если они должны работать именно из этого проекта.
