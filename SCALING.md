# Масштабирование WhatsApp Manager

## Текущие ограничения

**Docker конфигурация:**
- Память: 2GB лимит
- CPU: 2 ядра
- **Максимум: 3-5 подключений одновременно**

---

## Варианты увеличения количества подключений

### Вариант 1: Увеличить ресурсы Docker (Простой)

Отредактируйте `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0'      # Было: 2.0
      memory: 4G       # Было: 2G
    reservations:
      cpus: '2.0'      # Было: 1.0
      memory: 2G       # Было: 1G
```

**Результат:** 10-12 одновременных подключений

---

### Вариант 2: Запуск без Docker (Средний)

Запуск напрямую на хосте использует все доступные ресурсы:

```bash
# Установка зависимостей
npm install

# Запуск базы данных
docker-compose up -d postgres

# Установка переменных окружения
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/wa_manager"

# Миграция БД
npx prisma migrate deploy

# Запуск серверов
npm run dev:all
```

**Результат:** Зависит от вашего железа
- 8GB RAM → 15-20 подключений
- 16GB RAM → 40-50 подключений
- 32GB RAM → 80-100 подключений

---

### Вариант 3: Оптимизация Puppeteer (Продвинутый)

Добавьте больше агрессивных флагов в `server/index.js`:

```javascript
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: accountId,
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      // НОВЫЕ ОПТИМИЗАЦИИ:
      '--disable-dev-tools',
      '--disable-extensions',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled',
      '--single-process',           // Экономит память
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
    ],
  },
});
```

**Результат:** +30-50% больше подключений (4-7 вместо 3-5)

---

### Вариант 4: Распределённая архитектура (Профессиональный)

Запустите несколько инстансов сервера за балансировщиком:

```yaml
# docker-compose.scale.yml
services:
  wa-manager-1:
    <<: *wa-manager
    container_name: wa-manager-1
    ports:
      - "5001:5001"

  wa-manager-2:
    <<: *wa-manager
    container_name: wa-manager-2
    ports:
      - "5002:5001"

  wa-manager-3:
    <<: *wa-manager
    container_name: wa-manager-3
    ports:
      - "5003:5001"

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    # Load balancer config
```

**Результат:** 9-15 подключений (3-5 на инстанс × 3 инстанса)

---

## Рекомендации по мониторингу

### Добавьте логирование использования ресурсов:

```javascript
// В server/index.js
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`
📊 Resource Usage:
  - Active clients: ${clients.size}
  - Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB
  - RSS: ${Math.round(used.rss / 1024 / 1024)}MB
  `);
}, 60000); // Каждую минуту
```

---

## Быстрый старт: Увеличить до 10 подключений

**Шаг 1:** Отредактируйте `docker-compose.yml`:
```bash
# Измените memory: 2G → 4G
# Измените cpus: '2.0' → '4.0'
```

**Шаг 2:** Перезапустите:
```bash
docker-compose down
docker-compose up -d
```

**Шаг 3:** Тест:
- Создайте 10 аккаунтов
- Подключите все одновременно
- Мониторьте через `docker stats wa-manager`

---

## FAQ

**Q: Сколько максимум подключений возможно теоретически?**
A: С достаточными ресурсами (64GB RAM, 16 cores) можно запустить 100-200 одновременных подключений.

**Q: Что произойдёт при превышении лимита?**
A:
1. Процесс может быть убит OOM killer
2. Клиенты будут падать с ошибками инициализации
3. Система станет очень медленной

**Q: Как узнать текущее использование?**
A:
```bash
# Docker
docker stats wa-manager

# Локально
top -p $(pgrep -f "node server/index.js")
```

**Q: Можно ли использовать удалённый браузер?**
A: Да! Можно подключить Puppeteer к удалённому Chrome через `browserWSEndpoint`, но это требует дополнительной настройки.
