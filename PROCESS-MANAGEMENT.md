# Управление процессами и автоматическое восстановление

## Обзор

Проект использует **PM2 (Process Manager 2)** для управления процессами и автоматического восстановления при сбоях. PM2 обеспечивает надежную работу приложения, автоматически перезапуская упавшие процессы.

## Архитектура

Приложение состоит из двух основных процессов:

1. **api-server** - Express сервер с WhatsApp клиентами (порт 5001)
2. **nextjs-server** - Next.js фронтенд (порт 3000)

Оба процесса управляются PM2 и автоматически восстанавливаются при сбоях.

## Многоуровневая защита от сбоев

### Уровень 1: PM2 Process Manager

PM2 управляет процессами внутри контейнера:

- **Автоматический перезапуск** при падении процесса
- **Exponential backoff** - задержка между перезапусками увеличивается
- **Лимит памяти** - автоматический перезапуск при превышении лимита
- **Graceful shutdown** - корректное завершение процессов
- **Логирование** - все логи сохраняются в `./logs/`

#### Конфигурация PM2 (`ecosystem.config.js`)

```javascript
{
  name: "api-server",
  script: "./server/index.js",
  instances: 1,
  autorestart: true,                    // Автоматический перезапуск
  max_memory_restart: "400M",           // Перезапуск при 400MB
  min_uptime: "10s",                    // Минимальное время работы
  max_restarts: 10,                     // Максимум перезапусков
  restart_delay: 4000,                  // Задержка между перезапусками (4 сек)
  exp_backoff_restart_delay: 100,       // Экспоненциальная задержка
  kill_timeout: 10000,                  // Timeout для graceful shutdown
}
```

### Уровень 2: Docker Container

Docker также обеспечивает восстановление:

- **restart: unless-stopped** - автоматический перезапуск контейнера
- **Health checks** - проверка состояния каждые 30 секунд
- **Restart policy** - политика перезапуска при сбоях

```yaml
restart: unless-stopped
healthcheck:
  test: ["CMD", "sh", "-c", "curl -f http://localhost:3000 && curl -f http://localhost:5001/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
deploy:
  restart_policy:
    condition: on-failure
    delay: 5s
    max_attempts: 3
    window: 120s
```

### Уровень 3: Application-level

Встроенная логика восстановления в приложении:

- **Reconnection с exponential backoff** для WhatsApp клиентов
- **Heartbeat мониторинг** - проверка каждые 30 секунд
- **Memory monitoring** - отслеживание утечек памяти
- **Graceful shutdown** - корректное завершение при SIGTERM/SIGINT

## Сценарии восстановления

### 1. Падение API сервера

**Что происходит:**
```
1. PM2 обнаруживает падение процесса api-server
2. PM2 ждет 4 секунды (restart_delay)
3. PM2 перезапускает api-server
4. Приложение восстанавливает WhatsApp клиенты автоматически
5. Все подключенные аккаунты переподключаются
```

**Время восстановления:** 5-15 секунд

### 2. Падение Next.js сервера

**Что происходит:**
```
1. PM2 обнаруживает падение процесса nextjs-server
2. PM2 ждет 4 секунды
3. PM2 перезапускает nextjs-server
4. Фронтенд снова доступен
```

**Время восстановления:** 5-10 секунд

### 3. Падение всего контейнера

**Что происходит:**
```
1. Docker обнаруживает падение контейнера
2. Docker ждет 5 секунд (restart_policy.delay)
3. Docker перезапускает контейнер
4. PM2 запускает оба процесса
5. Приложение восстанавливает состояние
```

**Время восстановления:** 30-60 секунд

### 4. Утечка памяти

**Что происходит:**
```
1. PM2 обнаруживает превышение лимита (400MB для API)
2. PM2 gracefully завершает процесс
3. PM2 запускает новый процесс
4. Состояние восстанавливается
```

### 5. Критическая ошибка в коде

**Что происходит:**
```
1. Процесс падает с uncaughtException
2. PM2 перезапускает процесс
3. Если падение повторяется 10 раз подряд:
   - PM2 прекращает попытки перезапуска
   - Docker health check падает
   - Docker перезапускает контейнер
```

## Мониторинг

### Просмотр статуса процессов

```bash
# Войти в контейнер
docker exec -it wa-manager sh

# Проверить статус PM2
pm2 status

# Вывод:
# ┌─────┬────────────────┬─────────┬─────────┬──────────┬────────┬──────┐
# │ id  │ name           │ mode    │ status  │ ↺        │ cpu    │ mem  │
# ├─────┼────────────────┼─────────┼─────────┼──────────┼────────┼──────┤
# │ 0   │ api-server     │ fork    │ online  │ 0        │ 5%     │ 250M │
# │ 1   │ nextjs-server  │ fork    │ online  │ 0        │ 2%     │ 180M │
# └─────┴────────────────┴─────────┴─────────┴──────────┴────────┴──────┘
```

### Просмотр логов

```bash
# Все логи
docker exec -it wa-manager pm2 logs

# Только API сервер
docker exec -it wa-manager pm2 logs api-server

# Только Next.js
docker exec -it wa-manager pm2 logs nextjs-server

# Логи из файлов
docker exec -it wa-manager tail -f logs/api-out.log
docker exec -it wa-manager tail -f logs/api-error.log
```

### Мониторинг в реальном времени

```bash
# Интерактивный мониторинг
docker exec -it wa-manager pm2 monit

# Показывает:
# - CPU и Memory usage
# - Логи в реальном времени
# - Количество перезапусков
```

### Health check

```bash
# Проверка здоровья контейнера
docker inspect wa-manager | grep -A 10 Health

# Проверка через API
curl http://localhost:5001/health

# Ответ:
{
  "status": "ok",
  "uptime": 3600,
  "activeClients": 3,
  "memory": {
    "heapUsed": 250,
    "heapTotal": 350,
    "heapPercent": 71
  }
}
```

## Управление процессами

### Локальная разработка (без Docker)

```bash
# Установить зависимости
npm install

# Запустить с PM2
npm run start:pm2

# Остановить
npm run stop:pm2

# Перезапустить
npm run restart:pm2

# Логи
npm run logs:pm2

# Мониторинг
npm run monit:pm2
```

### В Docker

```bash
# Пересобрать и запустить
docker-compose up -d --build

# Посмотреть логи
docker-compose logs -f wa-manager

# Перезапустить контейнер
docker-compose restart wa-manager

# Остановить
docker-compose down

# Остановить и удалить volumes (ОСТОРОЖНО!)
docker-compose down -v
```

### Ручное управление PM2 в контейнере

```bash
# Войти в контейнер
docker exec -it wa-manager sh

# Перезапустить только API сервер
pm2 restart api-server

# Перезапустить только Next.js
pm2 restart nextjs-server

# Остановить процесс
pm2 stop api-server

# Запустить процесс
pm2 start api-server

# Удалить процесс из PM2
pm2 delete api-server

# Перезагрузить конфигурацию
pm2 reload ecosystem.config.js
```

## Тестирование автовосстановления

### Тест 1: Убить API процесс

```bash
# Найти PID процесса
docker exec -it wa-manager pm2 status

# Убить процесс
docker exec -it wa-manager pm2 stop api-server

# Наблюдать за автоматическим перезапуском
docker exec -it wa-manager pm2 logs api-server
```

**Ожидаемый результат:** Процесс автоматически перезапустится через 4 секунды

### Тест 2: Симуляция краша

```bash
# Добавить в server/index.js временный код для теста:
setTimeout(() => {
  throw new Error("Test crash");
}, 30000);

# Пересобрать
docker-compose up -d --build

# Наблюдать за логами
docker-compose logs -f wa-manager

# Через 30 секунд процесс упадет и автоматически восстановится
```

### Тест 3: Проверка health check

```bash
# Остановить оба процесса
docker exec -it wa-manager pm2 stop all

# Подождать 90 секунд (3 неудачные проверки)
# Docker автоматически перезапустит контейнер

# Проверить статус
docker ps
docker-compose logs wa-manager
```

## Отладка проблем

### Процесс постоянно падает

**Проверить логи:**
```bash
docker exec -it wa-manager pm2 logs api-server --lines 100
docker exec -it wa-manager cat logs/api-error.log
```

**Увеличить лимиты:**
```javascript
// ecosystem.config.js
max_memory_restart: "800M",  // Увеличить лимит памяти
max_restarts: 20,            // Увеличить количество попыток
```

### Процессы не запускаются

**Проверить статус PM2:**
```bash
docker exec -it wa-manager pm2 status
docker exec -it wa-manager pm2 describe api-server
```

**Проверить переменные окружения:**
```bash
docker exec -it wa-manager env | grep -E "DATABASE_URL|REDIS_HOST|API_PORT"
```

**Ручной запуск для диагностики:**
```bash
docker exec -it wa-manager node server/index.js
```

### Health check падает

**Проверить порты:**
```bash
docker exec -it wa-manager netstat -tulpn | grep -E "3000|5001"
```

**Проверить health endpoints:**
```bash
docker exec -it wa-manager curl http://localhost:3000
docker exec -it wa-manager curl http://localhost:5001/health
```

## Лучшие практики

### 1. Регулярный мониторинг

```bash
# Ежедневно проверять статус
docker exec -it wa-manager pm2 status

# Проверять количество перезапусков (↺)
# Если больше 5 - расследовать причину
```

### 2. Анализ логов

```bash
# Еженедельно анализировать ошибки
docker exec -it wa-manager grep "ERROR" logs/api-error.log | tail -100
```

### 3. Обновление PM2

```bash
# В package.json обновить версию PM2
"pm2": "^5.4.3"  # Актуальная версия

# Пересобрать контейнер
docker-compose up -d --build
```

### 4. Настройка алертов

Можно интегрировать PM2 с системами мониторинга:
- PM2 Plus (платный сервис от разработчиков PM2)
- Prometheus + Grafana
- Custom webhooks на критические события

## Преимущества PM2

✅ **Автоматическое восстановление** - процессы поднимаются сами
✅ **Нет простоя** - быстрое восстановление (секунды)
✅ **Логирование** - все события записываются
✅ **Мониторинг** - встроенные инструменты
✅ **Graceful reload** - без потери соединений
✅ **Memory management** - защита от утечек
✅ **Кластеризация** - легко масштабировать (если нужно)

## Итог

Теперь ваше приложение **полностью защищено от падений**:

1. PM2 перезапускает упавшие процессы внутри контейнера
2. Docker перезапускает упавший контейнер
3. Приложение автоматически восстанавливает WhatsApp соединения
4. Все события логируются для анализа

**Даже при большой нагрузке и множестве сообщений система будет работать стабильно!**
