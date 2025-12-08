# 📱 WhatsApp Manager - Client Integration Guide

Простая инструкция как подключить WhatsApp аккаунт к твоему приложению.

---

## 🚀 Быстрый старт

### 1. Создать аккаунт

**POST** `https://ilovesanzhar.click/api/accounts`

```javascript
const response = await fetch('https://ilovesanzhar.click/api/accounts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'My WhatsApp Account',  // Любое имя
    useLimits: false              // false = без лимитов (для прогретых аккаунтов)
                                  // true = с лимитами (для новых аккаунтов)
  })
});

const account = await response.json();
console.log(account);
// {
//   "id": "cm1234567890",
//   "name": "My WhatsApp Account",
//   "status": "DISCONNECTED",
//   "useLimits": false,
//   "qrCode": null,
//   "phoneNumber": null,
//   "createdAt": "2025-12-01T10:00:00.000Z"
// }
```

**Сохрани `account.id` - он понадобится для всех остальных запросов!**

---

### 2. Получить QR ссылку для клиента

После создания аккаунта, сформируй ссылку для клиента:

```javascript
const accountId = account.id; // ID из шага 1
const qrLink = `https://ilovesanzhar.click/qr/${accountId}`;

// Отправь эту ссылку клиенту любым способом:
// - Email
// - SMS
// - Telegram
// - WhatsApp
// - QR код

console.log('Отправь клиенту эту ссылку:', qrLink);
```

**Клиент открывает ссылку и автоматически видит QR код для сканирования!**

---

### 3. Проверить статус подключения

**GET** `https://ilovesanzhar.click/api/accounts/{accountId}`

```javascript
const accountId = 'cm1234567890'; // Твой ID аккаунта

const response = await fetch(`https://ilovesanzhar.click/api/accounts/${accountId}`);
const account = await response.json();

console.log(account.clientStatus);
// "DISCONNECTED"   - не подключен
// "CONNECTING"     - подключается
// "QR_READY"       - QR код готов к сканированию
// "AUTHENTICATING" - сканируется
// "CONNECTED"      - подключен! ✅
// "FAILED"         - ошибка подключения

console.log(account.phoneNumber); // null пока не подключен
// После подключения: "+1234567890"
```

**Рекомендация:** Проверяй статус каждые 3-5 секунд пока статус не станет `CONNECTED`.

---

### 4. Отправить сообщение

**POST** `https://ilovesanzhar.click/api/messages/send`

```javascript
const response = await fetch('https://ilovesanzhar.click/api/messages/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    accountId: 'cm1234567890',      // Твой ID аккаунта
    to: '77777777777',              // Номер получателя (без +)
    message: 'Hello from API! 👋'   // Текст сообщения
  })
});

const result = await response.json();
console.log(result);
// {
//   "success": true,
//   "queued": true,
//   "messageId": "msg_123456",
//   "queuePosition": 1,
//   "status": "CONNECTED"
// }
```

**Сообщения отправляются через очередь автоматически!**

---

## 📋 Все доступные эндпоинты

### Управление аккаунтом

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/accounts` | Создать аккаунт |
| GET | `/api/accounts` | Получить все аккаунты |
| GET | `/api/accounts/{id}` | Получить один аккаунт |
| PUT | `/api/accounts/{id}` | Обновить аккаунт (name, useLimits) |
| DELETE | `/api/accounts/{id}` | Удалить аккаунт |
| POST | `/api/accounts/{id}/connect` | Подключить аккаунт (генерирует QR) |
| POST | `/api/accounts/{id}/disconnect` | Отключить аккаунт |

### Сообщения

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/messages/send` | Отправить сообщение |
| GET | `/api/accounts/{id}/queue` | Проверить очередь сообщений |

### Чаты

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/accounts/{id}/chats` | Получить все чаты |
| GET | `/api/accounts/{id}/chats/{chatId}` | Сообщения из чата |
| POST | `/api/accounts/{id}/chats/{chatId}` | Отправить в чат |

---

## 💡 Примеры использования

### React / Next.js

```jsx
'use client';
import { useState, useEffect } from 'react';

export default function WhatsAppConnect() {
  const [account, setAccount] = useState(null);
  const [qrLink, setQrLink] = useState('');

  // 1. Создать аккаунт
  const createAccount = async () => {
    const res = await fetch('https://ilovesanzhar.click/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Client WhatsApp',
        useLimits: false
      })
    });
    const data = await res.json();
    setAccount(data);
    setQrLink(`https://ilovesanzhar.click/qr/${data.id}`);
  };

  // 2. Проверять статус
  useEffect(() => {
    if (!account) return;

    const interval = setInterval(async () => {
      const res = await fetch(`https://ilovesanzhar.click/api/accounts/${account.id}`);
      const data = await res.json();
      setAccount(data);

      if (data.clientStatus === 'CONNECTED') {
        clearInterval(interval);
        alert('WhatsApp подключен! ✅');
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [account]);

  // 3. Отправить сообщение
  const sendMessage = async () => {
    await fetch('https://ilovesanzhar.click/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        to: '77777777777',
        message: 'Test message'
      })
    });
  };

  return (
    <div>
      {!account ? (
        <button onClick={createAccount}>Создать аккаунт</button>
      ) : (
        <div>
          <h3>Статус: {account.clientStatus}</h3>
          {account.phoneNumber && <p>Номер: {account.phoneNumber}</p>}

          {account.clientStatus !== 'CONNECTED' && (
            <div>
              <p>Отправь клиенту эту ссылку:</p>
              <a href={qrLink} target="_blank">{qrLink}</a>
              <button onClick={() => navigator.clipboard.writeText(qrLink)}>
                📋 Копировать
              </button>
            </div>
          )}

          {account.clientStatus === 'CONNECTED' && (
            <button onClick={sendMessage}>Отправить сообщение</button>
          )}
        </div>
      )}
    </div>
  );
}
```

---

### Vanilla JavaScript

```html
<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Integration</title>
</head>
<body>
  <button id="create">Создать аккаунт</button>
  <div id="status"></div>
  <div id="qr"></div>

  <script>
    const API = 'https://ilovesanzhar.click';
    let accountId = null;

    // Создать аккаунт
    document.getElementById('create').addEventListener('click', async () => {
      const res = await fetch(`${API}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Account', useLimits: false })
      });
      const account = await res.json();
      accountId = account.id;

      const qrLink = `${API}/qr/${accountId}`;
      document.getElementById('qr').innerHTML = `
        <p>Отправь клиенту: <a href="${qrLink}" target="_blank">${qrLink}</a></p>
        <button onclick="navigator.clipboard.writeText('${qrLink}')">📋 Копировать</button>
      `;

      checkStatus();
    });

    // Проверять статус
    async function checkStatus() {
      const res = await fetch(`${API}/api/accounts/${accountId}`);
      const account = await res.json();

      document.getElementById('status').innerText = `Статус: ${account.clientStatus}`;

      if (account.clientStatus === 'CONNECTED') {
        alert('Подключено! ✅');
      } else {
        setTimeout(checkStatus, 3000);
      }
    }
  </script>
</body>
</html>
```

---

### Python

```python
import requests
import time

API_URL = "https://ilovesanzhar.click"

# 1. Создать аккаунт
response = requests.post(f"{API_URL}/api/accounts", json={
    "name": "Python Client",
    "useLimits": False
})
account = response.json()
account_id = account["id"]

# 2. QR ссылка
qr_link = f"{API_URL}/qr/{account_id}"
print(f"Отправь клиенту: {qr_link}")

# 3. Ждать подключения
while True:
    response = requests.get(f"{API_URL}/api/accounts/{account_id}")
    account = response.json()
    status = account["clientStatus"]

    print(f"Статус: {status}")

    if status == "CONNECTED":
        print(f"✅ Подключено! Номер: {account['phoneNumber']}")
        break

    time.sleep(3)

# 4. Отправить сообщение
requests.post(f"{API_URL}/api/messages/send", json={
    "accountId": account_id,
    "to": "77777777777",
    "message": "Hello from Python!"
})
print("✉️ Сообщение отправлено!")
```

---

## ⚙️ Настройки лимитов

При создании аккаунта можешь выбрать режим:

### С лимитами (`useLimits: true`)
- ✅ Безопасно для новых аккаунтов
- 📊 20 сообщений в минуту
- 📊 500-1000 сообщений в день
- ⏰ Задержки между сообщениями 3-8 сек
- ⏸️ Отдых после каждых 5 сообщений

### Без лимитов (`useLimits: false`)
- 🚀 Для прогретых аккаунтов
- ⚡ Неограниченное количество сообщений
- ⚡ Минимальные задержки (100ms)
- ⚡ Без периодов отдыха

**Рекомендация:** Для новых аккаунтов всегда используй `useLimits: true` первые 7 дней!

---

## 🔐 CORS & Security

API настроен на работу с любых доменов (CORS разрешен).

⚠️ **Важно:** Не храни чувствительные данные на клиенте. В production рекомендуется:
1. Создавать прокси на своем бэкенде
2. Добавить аутентификацию пользователей
3. Ограничить доступ к API только с твоего домена

---

## 📞 Поддержка

Если что-то не работает:
1. Проверь что API доступен: `curl https://ilovesanzhar.click/health`
2. Проверь статус аккаунта через GET `/api/accounts/{id}`
3. Проверь логи очереди: GET `/api/accounts/{id}/queue`

---

## 📚 Дополнительные примеры

### Проверить очередь сообщений

```javascript
const res = await fetch(`https://ilovesanzhar.click/api/accounts/${accountId}/queue`);
const queue = await res.json();

console.log(queue);
// {
//   "queueLength": 5,
//   "messages": [...],
//   "status": {
//     "clientStatus": "CONNECTED",
//     "isResting": false,
//     "messagesSinceRest": 3
//   },
//   "limits": {
//     "dailyCount": 150,
//     "dailyLimit": 1000
//   }
// }
```

### Изменить настройки аккаунта

```javascript
// Включить/выключить лимиты
await fetch(`https://ilovesanzhar.click/api/accounts/${accountId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    useLimits: false  // переключить на unlimited
  })
});
```

### Получить все чаты

```javascript
const res = await fetch(`https://ilovesanzhar.click/api/accounts/${accountId}/chats?page=1&limit=50`);
const chats = await res.json();

console.log(chats.data); // Массив чатов
console.log(chats.pagination); // Пагинация
```

---

**Готово! Это всё что нужно для интеграции 🚀**
