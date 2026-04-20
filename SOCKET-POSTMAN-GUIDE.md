# 🔌 Руководство по подключению через WebSocket (Postman)

## Проблема которую вы испытывали

Вы отправляли:
```
42["message:send",{"accountId":"...","to":"...","message":"hi dear"}]
```

**Но не получали ответ**, потому что **не указали ID для callback**!

---

## ✅ Правильная последовательность для Postman

### Шаг 1: Подключение к WebSocket

```
URL: wss://ilovesanzhar.click/socket.io/?EIO=4&transport=websocket
```

### Шаг 2: После подключения вы получите

```
0{"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}
```

### Шаг 3: Подключитесь к namespace /chats

Отправьте:
```
40/chats
```

Получите:
```
40/chats{"sid":"..."}
```

### Шаг 4: Присоединитесь к комнате (важно!)

Отправьте:
```
42/chats,["join","cmnxk4zgs0001ms2992ixarnq"]
```

**Без этого шага вы не получите broadcast события!**

### Шаг 5: Отправьте сообщение С CALLBACK ID

**❌ Неправильно (без ID):**
```
42/chats,["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]
```

**✅ Правильно (с ID):**
```
42/chats,1["message:send",{"accountId":"cmnxk4zgs0001ms2992ixarnq","to":"996500353529","message":"hi dear"}]
        ^
        └─ Это ID для callback (ACK)
```

### Шаг 6: Получите ответы

**A) Мгновенный callback (ACK):**
```
43/chats,1[{"success":true,"queued":true,"messageId":"1776363892103-79k22gpxo","queuePosition":1,"message":"Message queued for delivery"}]
         ^
         └─ Тот же ID что вы отправили
```

**B) Broadcast событие когда сообщение отправлено:**
```
42/chats,["chat:message:sent",{"accountId":"...","messageId":"...","status":"sent"}]
```

---

## 📊 Расшифровка Socket.IO протокола

### Коды пакетов:

| Код | Тип | Описание |
|-----|-----|----------|
| `0` | CONNECT | Подключение к серверу |
| `1` | DISCONNECT | Отключение |
| `2` | EVENT | Событие (default namespace) |
| `3` | ACK | Ответ на событие (default namespace) |
| `4` | ERROR | Ошибка |
| `40` | CONNECT namespace | Подключение к namespace |
| `41` | DISCONNECT namespace | Отключение от namespace |
| `42` | EVENT namespace | Событие в namespace |
| `43` | ACK namespace | Ответ в namespace |

### Формат сообщений:

**Событие без callback:**
```
42/chats,["event_name",{data}]
```

**Событие с callback:**
```
42/chats,<ID>["event_name",{data}]
```

**Ответ (ACK):**
```
43/chats,<ID>[{response}]
```

---

## 🎯 Полная последовательность для Postman

1. ✅ Подключение: получаем `0{...}`
2. ✅ Namespace: отправляем `40/chats` → получаем `40/chats{...}`
3. ✅ Join room: отправляем `42/chats,["join","YOUR_ACCOUNT_ID"]`
4. ✅ Отправка: отправляем `42/chats,1["message:send",{...}]`
5. ✅ Callback: получаем `43/chats,1[{success:true,...}]`
6. ✅ Broadcast: получаем `42/chats,["chat:message:sent",{...}]`

---

## 🔍 События которые можно слушать

После присоединения к комнате через `join(accountId)`, вы будете получать:

### `chat:message:new`
Новое входящее/исходящее сообщение
```json
{
  "accountId": "...",
  "chatId": "...",
  "message": { /* Message object */ }
}
```

### `chat:message:sent`
Сообщение успешно отправлено
```json
{
  "accountId": "...",
  "messageId": "...",
  "status": "sent",
  "timestamp": "..."
}
```

### `chat:message:failed`
Сообщение не удалось отправить
```json
{
  "accountId": "...",
  "messageId": "...",
  "status": "failed",
  "error": "...",
  "timestamp": "..."
}
```

---

## 💡 Рекомендации

1. **Используйте Socket.IO клиент** вместо raw WebSocket для production
2. **Всегда делайте `join(accountId)`** перед отправкой сообщений
3. **Используйте callback ID** чтобы получать мгновенные ответы
4. **Слушайте broadcast события** для real-time обновлений
5. **Храните connection ID** для reconnect логики

---

## 🧪 Тестирование

Используйте предоставленный скрипт `test-socket.js`:

```bash
npm install socket.io-client
node test-socket.js
```

Или используйте Postman с этой инструкцией!
