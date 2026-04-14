# WebSocket API Documentation

## Connection

Connect to WebSocket server using Socket.IO client.

```javascript
import { io } from 'socket.io-client';

// Production
const socket = io('/accounts', {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

// Development
const socket = io('http://localhost:5001/accounts', {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});
```

## Namespaces

The API uses three namespaces:
- `/accounts` - Account management
- `/chats` - Messages and chats
- `/qr` - QR code for authentication

---

## Namespace: /accounts

### Events (Client → Server)

#### `join`
Subscribe to account updates.
```javascript
socket.emit('join', accountId);
```

#### `leave`
Unsubscribe from account updates.
```javascript
socket.emit('leave', accountId);
```

#### `accounts:list`
Get all accounts.
```javascript
socket.emit('accounts:list', (response) => {
  // response: { success: boolean, data: Account[] }
});
```

Response:
```javascript
{
  success: true,
  data: [
    {
      id: "abc123",
      name: "My Account",
      status: "CONNECTED",
      phoneNumber: "996500353529",
      useLimits: true,
      clientStatus: "CONNECTED",
      hasActiveClient: true,
      lastHeartbeat: "2024-01-01T12:00:00Z",
      createdAt: "2024-01-01T10:00:00Z"
    }
  ]
}
```

#### `account:get`
Get account by ID.
```javascript
socket.emit('account:get', { accountId: "abc123" }, (response) => {
  // response: { success: boolean, data: Account }
});
```

#### `account:create`
Create new account.
```javascript
socket.emit('account:create', {
  name: "New Account",
  useLimits: true  // Enable human-like behavior
}, (response) => {
  // response: { success: boolean, data: Account }
});
```

#### `account:update`
Update account.
```javascript
socket.emit('account:update', {
  accountId: "abc123",
  name: "Updated Name",
  useLimits: false
}, (response) => {
  // response: { success: boolean, data: Account }
});
```

#### `account:connect`
Start WhatsApp session (will generate QR code).
```javascript
socket.emit('account:connect', { accountId: "abc123" }, (response) => {
  // response: { success: boolean, message?: string }
});
```

#### `account:disconnect`
Disconnect WhatsApp session.
```javascript
socket.emit('account:disconnect', { accountId: "abc123" }, (response) => {
  // response: { success: boolean }
});
```

#### `account:reset`
Reset session (delete auth data, need to scan QR again).
```javascript
socket.emit('account:reset', { accountId: "abc123" }, (response) => {
  // response: { success: boolean }
});
```

#### `account:delete`
Delete account completely.
```javascript
socket.emit('account:delete', { accountId: "abc123" }, (response) => {
  // response: { success: boolean }
});
```

### Events (Server → Client)

#### `account:status`
Account status changed.
```javascript
socket.on('account:status', (data) => {
  // data: { accountId, status, phoneNumber? }
});
```

#### `account:created`
New account created.
```javascript
socket.on('account:created', (account) => {
  // account: Account object
});
```

#### `account:updated`
Account updated.
```javascript
socket.on('account:updated', (account) => {
  // account: Account object
});
```

#### `account:deleted`
Account deleted.
```javascript
socket.on('account:deleted', ({ accountId }) => {
  // accountId: string
});
```

---

## Namespace: /chats

### Events (Client → Server)

#### `join`
Subscribe to account's messages (receive real-time updates).
```javascript
const chatsSocket = io('/chats');
chatsSocket.emit('join', accountId);
```

#### `leave`
Unsubscribe from account's messages.
```javascript
chatsSocket.emit('leave', accountId);
```

#### `chats:list`
Get all chats (grouped by contact) for an account.
```javascript
chatsSocket.emit('chats:list', {
  accountId: "abc123",
  page: 1,        // optional, default: 1
  limit: 50,      // optional, default: 50, max: 100
  phone: "996"    // optional, filter by phone
}, (response) => {
  // response: { success, data: Chat[], pagination }
});
```

Response:
```javascript
{
  success: true,
  data: [
    {
      chatId: "996500353529@s.whatsapp.net",
      contactNumber: "996500353529",
      contactName: "John",
      lastMessage: "Hello!",
      lastMessageTime: "2024-01-01T12:00:00Z",
      lastMessageDirection: "OUTGOING",
      messageCount: 15,
      unreadCount: 0
    }
  ],
  pagination: {
    total: 10,
    page: 1,
    limit: 50,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false
  }
}
```

#### `chat:messages`
Get messages for a specific chat.
```javascript
chatsSocket.emit('chat:messages', {
  accountId: "abc123",
  chatId: "996500353529@s.whatsapp.net",  // or just "996500353529"
  limit: 100,    // optional, default: 100, max: 500
  offset: 0      // optional, default: 0
}, (response) => {
  // response: { success, data: Message[], pagination }
});
```

Response:
```javascript
{
  success: true,
  data: [
    {
      id: "msg123",
      chatId: "996500353529@s.whatsapp.net",
      direction: "OUTGOING",  // or "INCOMING"
      message: "Hello!",
      status: "SENT",
      contactNumber: "996500353529",
      contactName: "John",
      sentAt: "2024-01-01T12:00:00Z",
      createdAt: "2024-01-01T12:00:00Z"
    }
  ],
  pagination: {
    count: 50,
    offset: 0,
    limit: 100
  }
}
```

#### `messages:history`
Get all messages history for an account.
```javascript
chatsSocket.emit('messages:history', {
  accountId: "abc123",
  limit: 100,          // optional, default: 100, max: 500
  offset: 0,           // optional, default: 0
  direction: "OUTGOING", // optional: "INCOMING" or "OUTGOING"
  startDate: "2024-01-01", // optional
  endDate: "2024-01-31"    // optional
}, (response) => {
  // response: { success, data: Message[], pagination }
});
```

Response:
```javascript
{
  success: true,
  data: [
    {
      id: "msg123",
      chatId: "996500353529@s.whatsapp.net",
      direction: "OUTGOING",
      message: "Hello!",
      status: "SENT",
      contactNumber: "996500353529",
      contactName: "John",
      to: "996500353529",
      from: null,
      sentAt: "2024-01-01T12:00:00Z",
      createdAt: "2024-01-01T12:00:00Z"
    }
  ],
  pagination: {
    total: 150,
    count: 100,
    offset: 0,
    limit: 100,
    hasMore: true
  }
}
```

#### `message:send`
Send message to a phone number.
```javascript
chatsSocket.emit('message:send', {
  accountId: "abc123",
  to: "996500353529",     // Phone number (without +)
  message: "Hello!"
}, (response) => {
  // response: { success, messageId, queued, queuePosition }
});
```

**Important**: Phone number should be WITHOUT `+` sign. Just digits: `996500353529`, not `+996500353529`.

Response:
```javascript
{
  success: true,
  queued: true,
  messageId: "1704067200000-abc123xyz",
  queuePosition: 1,
  message: "Message queued for delivery"
}
```

#### `chat:send`
Send message to a specific chat (by chatId).
```javascript
chatsSocket.emit('chat:send', {
  accountId: "abc123",
  chatId: "996500353529@s.whatsapp.net",
  message: "Hello!"
}, (response) => {
  // response: { success, messageId, queued, queuePosition }
});
```

#### `queue:status`
Get message queue status for an account.
```javascript
chatsSocket.emit('queue:status', {
  accountId: "abc123"
}, (response) => {
  // response: { success, data: QueueStatus }
});
```

Response:
```javascript
{
  success: true,
  data: {
    accountId: "abc123",
    queueLength: 3,
    clientStatus: "CONNECTED",
    messages: [
      {
        position: 1,
        to: "996500353529",
        messagePreview: "Hello! This is a test...",
        retries: 0,
        createdAt: 1704067200000
      }
    ]
  }
}
```

### Events (Server → Client)

After joining a room with `join(accountId)`, you'll receive:

#### `chat:message:new`
New message received or sent.
```javascript
chatsSocket.on('chat:message:new', (data) => {
  // data: { accountId, chatId, message: Message }
});
```

#### `chat:message:sent`
Message successfully delivered.
```javascript
chatsSocket.on('chat:message:sent', (data) => {
  // data: { accountId, messageId, chatId, status }
});
```

#### `chat:message:failed`
Message failed to send.
```javascript
chatsSocket.on('chat:message:failed', (data) => {
  // data: { accountId, messageId, chatId, error }
});
```

---

## Namespace: /qr

### Events (Client → Server)

#### `join`
Subscribe to QR code updates for an account.
```javascript
const qrSocket = io('/qr');
qrSocket.emit('join', accountId);
```

#### `leave`
Unsubscribe from QR code updates.
```javascript
qrSocket.emit('leave', accountId);
```

### Events (Server → Client)

#### `qr:generated`
New QR code generated (scan with WhatsApp).
```javascript
qrSocket.on('qr:generated', (data) => {
  // data: { accountId, qrCode, expiresIn }
  // qrCode is a base64 data URL, can be used directly in <img src="...">
});
```

---

## Complete Example

```javascript
import { io } from 'socket.io-client';

const API_URL = 'http://localhost:5001';

// Connect to namespaces
const accountsSocket = io(`${API_URL}/accounts`, { path: '/socket.io' });
const chatsSocket = io(`${API_URL}/chats`, { path: '/socket.io' });
const qrSocket = io(`${API_URL}/qr`, { path: '/socket.io' });

// 1. Get all accounts
accountsSocket.emit('accounts:list', (response) => {
  if (response.success) {
    console.log('Accounts:', response.data);

    const account = response.data[0];
    if (account) {
      // 2. Join rooms for real-time updates
      chatsSocket.emit('join', account.id);
      qrSocket.emit('join', account.id);

      // 3. Get chats for this account
      chatsSocket.emit('chats:list', { accountId: account.id }, (res) => {
        console.log('Chats:', res.data);
      });

      // 4. Send a message
      chatsSocket.emit('message:send', {
        accountId: account.id,
        to: '996500353529',  // WITHOUT + sign!
        message: 'Hello from WebSocket!'
      }, (res) => {
        console.log('Message queued:', res);
      });
    }
  }
});

// Listen for real-time message updates
chatsSocket.on('chat:message:new', (data) => {
  console.log('New message:', data);
});

// Listen for QR code (when connecting new account)
qrSocket.on('qr:generated', (data) => {
  console.log('Scan QR code:', data.qrCode);
});

// Listen for account status changes
accountsSocket.on('account:status', (data) => {
  console.log('Account status:', data);
});
```

---

## Status Values

### Account Status
- `DISCONNECTED` - Not connected
- `CONNECTING` - Connecting to WhatsApp
- `QR_READY` - QR code ready to scan
- `AUTHENTICATING` - Authenticating after QR scan
- `CONNECTED` - Connected and ready
- `FAILED` - Connection failed

### Message Direction
- `INCOMING` - Message received from contact
- `OUTGOING` - Message sent to contact

### Message Status
- `PENDING` - In queue
- `SENT` - Sent successfully
- `DELIVERED` - Delivered to recipient
- `READ` - Read by recipient
- `FAILED` - Failed to send

---

## Error Handling

All responses include `success` field:

```javascript
// Success
{ success: true, data: ... }

// Error
{ success: false, error: "Error message" }
```

Always check `success` before using `data`:

```javascript
socket.emit('message:send', data, (response) => {
  if (response.success) {
    console.log('Message sent:', response.messageId);
  } else {
    console.error('Error:', response.error);
  }
});
```

---

## Phone Number Format

**Important**: Always use phone numbers WITHOUT the `+` sign.

- Correct: `996500353529`
- Wrong: `+996500353529`

The system will automatically normalize phone numbers, but it's best to send them in the correct format.
