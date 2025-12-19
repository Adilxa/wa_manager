# WhatsApp Manager - Multi-Account System

Система управления множественными аккаунтами WhatsApp с веб-интерфейсом.

## Возможности

- Создание и управление множественными WhatsApp аккаунтами
- Отдельная QR авторизация для каждого аккаунта
- Web Dashboard для управления всеми аккаунтами
- Отправка сообщений через любой подключенный аккаунт
- История всех отправленных сообщений в базе данных
- Автоматическое восстановление подключений после перезапуска
- REST API для интеграции с другими системами

## Технологии

- **Next.js 16** - фронтенд и бэкенд в одном проекте
- **TypeScript** - типизация для надежности
- **Prisma ORM** - работа с базой данных
- **Supabase (PostgreSQL)** - хранение данных
- **WhatsApp Web.js** - работа с WhatsApp
- **Puppeteer** - браузерная автоматизация
- **Tailwind CSS** - стилизация интерфейса

## Установка и запуск

### 1. Установка зависимостей

\`\`\`bash
npm install
\`\`\`

### 2. Настройка базы данных

1. Создайте аккаунт на [Supabase](https://supabase.com)
2. Создайте новый проект
3. Скопируйте строки подключения к БД
4. Создайте файл \`.env\` и добавьте:

\`\`\`env
DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-[region].pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.[project-ref]:[password]@aws-[region].pooler.supabase.com:5432/postgres"

NEXT_PUBLIC_APP_URL=http://localhost:3000
API_SECRET_KEY=your-secret-key-here
\`\`\`

### 3. Инициализация базы данных

\`\`\`bash
npm run prisma:push
\`\`\`

### 4. Запуск сервера

Для разработки:
\`\`\`bash
npm run dev
\`\`\`

Для продакшена:
\`\`\`bash
npm run build
npm start
\`\`\`

Откройте [http://localhost:3000](http://localhost:3000) в браузере.

## Использование Web Dashboard

### Создание аккаунта

1. Введите имя для нового аккаунта (например, "Мой бизнес")
2. Нажмите "Create"
3. Аккаунт появится в списке со статусом "DISCONNECTED"

### Подключение аккаунта

1. Нажмите кнопку "Connect" на карточке аккаунта
2. Дождитесь, пока статус изменится на "QR_READY"
3. Кликните на аккаунт, чтобы увидеть QR код
4. Отсканируйте QR код в WhatsApp на телефоне:
   - Откройте WhatsApp
   - Перейдите в Настройки → Связанные устройства
   - Нажмите "Связать устройство"
   - Отсканируйте QR код
5. После сканирования статус изменится на "CONNECTED"

### Отправка сообщений

1. Выберите подключенный аккаунт (статус "CONNECTED")
2. В правой панели появится форма отправки
3. Введите номер телефона (например, 79991234567)
4. Введите текст сообщения
5. Нажмите "Send Message"

### Управление аккаунтами

- **Disconnect** - отключить аккаунт (можно переподключить позже)
- **Delete** - удалить аккаунт навсегда (вместе с историей сообщений)

## REST API

### Получить все аккаунты

\`\`\`http
GET /api/accounts
\`\`\`

Ответ:
\`\`\`json
[
{
"id": "clxxx...",
"name": "My Business",
"phoneNumber": "1234567890",
"status": "CONNECTED",
"clientStatus": "CONNECTED",
"hasActiveClient": true,
"createdAt": "2024-01-01T00:00:00.000Z"
}
]
\`\`\`

### Создать аккаунт

\`\`\`http
POST /api/accounts
Content-Type: application/json

{
"name": "Account Name"
}
\`\`\`

### Подключить аккаунт

\`\`\`http
POST /api/accounts/{id}/connect
\`\`\`

### Отключить аккаунт

\`\`\`http
POST /api/accounts/{id}/disconnect
\`\`\`

### Удалить аккаунт

\`\`\`http
DELETE /api/accounts/{id}
\`\`\`

### Отправить сообщение

\`\`\`http
POST /api/messages/send
Content-Type: application/json

{
"accountId": "clxxx...",
"to": "1234567890",
"message": "Hello from WhatsApp Manager!"
}
\`\`\`

Ответ при успехе:
\`\`\`json
{
"success": true,
"messageId": "true_1234567890@c.us_xxx"
}
\`\`\`

### Получить историю сообщений

\`\`\`http
GET /api/accounts/{id}/messages?limit=50
\`\`\`

## Структура проекта

\`\`\`
wa-manager/
├── app/
│ ├── api/
│ │ ├── accounts/ # API управления аккаунтами
│ │ │ ├── route.ts # GET, POST
│ │ │ └── [id]/
│ │ │ ├── route.ts # GET, DELETE
│ │ │ ├── connect/ # POST подключение
│ │ │ ├── disconnect/# POST отключение
│ │ │ └── messages/ # GET история
│ │ └── messages/
│ │ └── send/ # POST отправка
│ ├── globals.css
│ ├── layout.tsx
│ └── page.tsx # Dashboard UI
├── lib/
│ ├── prisma.ts # Prisma клиент
│ └── whatsapp/
│ ├── manager.ts # WhatsApp менеджер
│ └── types.ts # TypeScript типы
├── prisma/
│ └── schema.prisma # Схема БД
├── .env # Переменные окружения
└── package.json
\`\`\`

## База данных

### Таблица \`whatsapp_accounts\`

| Поле        | Тип      | Описание                           |
| ----------- | -------- | ---------------------------------- |
| id          | String   | Уникальный ID                      |
| name        | String   | Имя аккаунта                       |
| phoneNumber | String?  | Номер телефона (после подключения) |
| status      | Enum     | Статус подключения                 |
| qrCode      | Text?    | QR код в формате Data URL          |
| sessionData | Text?    | Данные сессии (зарезервировано)    |
| createdAt   | DateTime | Дата создания                      |
| updatedAt   | DateTime | Дата обновления                    |

### Таблица \`messages\`

| Поле      | Тип      | Описание         |
| --------- | -------- | ---------------- |
| id        | String   | Уникальный ID    |
| accountId | String   | ID аккаунта      |
| to        | String   | Номер получателя |
| message   | Text     | Текст сообщения  |
| status    | Enum     | Статус доставки  |
| sentAt    | DateTime | Дата отправки    |
| updatedAt | DateTime | Дата обновления  |

### Статусы аккаунтов

- \`DISCONNECTED\` - не подключен
- \`CONNECTING\` - идет подключение
- \`QR_READY\` - QR код готов к сканированию
- \`AUTHENTICATING\` - идет аутентификация
- \`CONNECTED\` - подключен и готов к работе
- \`FAILED\` - ошибка подключения

### Статусы сообщений

- \`PENDING\` - ожидает отправки
- \`SENT\` - отправлено
- \`DELIVERED\` - доставлено
- \`READ\` - прочитано
- \`FAILED\` - ошибка отправки

## Особенности работы

### Множественные аккаунты

Каждый аккаунт работает в отдельном WhatsApp Web клиенте с уникальной сессией. Сессии сохраняются в директории \`.wwebjs_auth/session-{accountId}\`.

### Автоматическое восстановление

При перезапуске сервера система автоматически восстанавливает все подключенные клиенты.

### QR код обновление

QR коды обновляются автоматически. Dashboard опрашивает API каждые 3 секунды и обновляет статусы.

### Хранение сообщений

Все отправленные сообщения сохраняются в базе данных для аналитики и истории.

## Скрипты

\`\`\`bash
npm run dev # Запуск в режиме разработки
npm run build # Сборка для продакшена
npm start # Запуск продакшен версии
npm run prisma:generate # Генерация Prisma клиента
npm run prisma:push # Отправка схемы в БД
npm run prisma:studio # Открыть Prisma Studio
npm run prisma:migrate # Создать миграцию
\`\`\`

## Производительность

### Рекомендации

- **RAM**: минимум 2GB на сервер + 200MB на каждый активный аккаунт
- **CPU**: рекомендуется 2+ ядра для множественных аккаунтов
- **Диск**: 500MB на каждый аккаунт (Chrome cache + сессии)

### Ограничения WhatsApp

WhatsApp Web имеет лимиты на количество сообщений:

- ~1000 сообщений в день на аккаунт
- ~40 сообщений в минуту

## Безопасность

- Все сессии хранятся локально
- Используйте HTTPS в продакшене
- Не делитесь QR кодами
- Регулярно обновляйте зависимости
- Используйте сильный \`API_SECRET_KEY\`

## Деплой

### Vercel (рекомендуется для фронтенда + API)

\`\`\`bash
npm install -g vercel
vercel
\`\`\`

**Важно**: Vercel не поддерживает Puppeteer. Для работы WhatsApp клиентов используйте VPS или Docker.

### VPS/Docker

1. Клонируйте репозиторий на сервер
2. Установите зависимости
3. Настройте \`.env\`
4. Запустите: \`npm run build && npm start\`

### Docker (в разработке)

\`\`\`dockerfile
FROM node:18-slim

# Dockerfile будет добавлен позже

\`\`\`

## Поддержка

Если возникли проблемы:

1. Проверьте логи в консоли
2. Проверьте соединение с базой данных
3. Убедитесь, что Chrome/Chromium установлен (для Puppeteer)
4. Проверьте права доступа к директории \`.wwebjs_auth\`

## Лицензия

MIT

## Разработчик

Создано для проекта
