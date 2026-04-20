/**
 * Тестовый скрипт для подключения к Socket.IO и отправки сообщений
 * Использование: node test-socket.js
 */

const { io } = require('socket.io-client');

// Конфигурация
const SERVER_URL = 'wss://ilovesanzhar.click';
const ACCOUNT_ID = 'cmnxk4zgs0001ms2992ixarnq';
const TO_PHONE = '996500353529';
const MESSAGE = 'hi dear';

console.log('🔌 Подключаемся к Socket.IO серверу...\n');

// Подключение к namespace /chats
const socket = io(`${SERVER_URL}/chats`, {
  transports: ['websocket'],
  reconnection: true,
});

// ============================================
// ОБРАБОТЧИКИ СОБЫТИЙ ПОДКЛЮЧЕНИЯ
// ============================================

socket.on('connect', () => {
  console.log('✅ Подключено к Socket.IO');
  console.log(`   Socket ID: ${socket.id}\n`);

  // ШАГ 1: Присоединиться к комнате accountId
  console.log(`📍 Присоединяемся к комнате: account:${ACCOUNT_ID}`);
  socket.emit('join', ACCOUNT_ID);

  // Ждем немного и отправляем сообщение
  setTimeout(() => {
    sendMessage();
  }, 1000);
});

socket.on('connect_error', (error) => {
  console.error('❌ Ошибка подключения:', error.message);
});

socket.on('disconnect', (reason) => {
  console.log('🔌 Отключено:', reason);
});

// ============================================
// ОБРАБОТЧИКИ СОБЫТИЙ ОТ СЕРВЕРА
// ============================================

// Новое сообщение (broadcast event)
socket.on('chat:message:new', (data) => {
  console.log('\n📨 Получено новое сообщение (broadcast):');
  console.log(JSON.stringify(data, null, 2));
});

// Сообщение успешно отправлено
socket.on('chat:message:sent', (data) => {
  console.log('\n✅ Сообщение отправлено (broadcast):');
  console.log(JSON.stringify(data, null, 2));
});

// Сообщение не удалось отправить
socket.on('chat:message:failed', (data) => {
  console.log('\n❌ Сообщение не отправлено (broadcast):');
  console.log(JSON.stringify(data, null, 2));
});

// ============================================
// ОТПРАВКА СООБЩЕНИЯ
// ============================================

function sendMessage() {
  console.log('\n📤 Отправляем сообщение...');
  console.log(`   Аккаунт: ${ACCOUNT_ID}`);
  console.log(`   Кому: ${TO_PHONE}`);
  console.log(`   Текст: ${MESSAGE}\n`);

  // ШАГ 2: Отправить сообщение с callback (ACK)
  socket.emit('message:send', {
    accountId: ACCOUNT_ID,
    to: TO_PHONE,
    message: MESSAGE
  }, (response) => {
    // Это callback - мгновенный ответ от сервера
    console.log('📩 Получен callback (ACK) от сервера:');
    console.log(JSON.stringify(response, null, 2));

    if (response.success) {
      console.log(`\n✅ Сообщение в очереди!`);
      console.log(`   Message ID: ${response.messageId}`);
      console.log(`   Позиция в очереди: ${response.queuePosition}`);
      console.log(`\n⏳ Ожидаем broadcast события (chat:message:sent)...`);
    } else {
      console.log(`\n❌ Ошибка: ${response.error}`);
      process.exit(1);
    }
  });
}

// Для теста - закрываем через 30 секунд если нет ответа
setTimeout(() => {
  console.log('\n⏰ Таймаут - закрываем подключение');
  socket.close();
  process.exit(0);
}, 30000);
