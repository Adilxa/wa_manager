# 🚀 VPS Deployment Guide - WhatsApp Manager

Полное руководство по развертыванию WhatsApp Manager на VPS с максимальной безопасностью и производительностью.

## 📋 Содержание

- [Требования](#требования)
- [Архитектура](#архитектура)
- [Подготовка VPS](#подготовка-vps)
- [Установка](#установка)
- [Настройка](#настройка)
- [WebSocket API](#websocket-api)
- [Безопасность](#безопасность)
- [Мониторинг](#мониторинг)
- [Troubleshooting](#troubleshooting)

---

## 🎯 Требования

### Минимальные требования VPS
- **CPU**: 2 ядра
- **RAM**: 4 GB
- **Disk**: 20 GB SSD
- **OS**: Ubuntu 22.04 LTS (рекомендуется)
- **Network**: Статический IP адрес
- **Domain**: Домен с настроенными DNS записями

### Рекомендуемые требования
- **CPU**: 4 ядра
- **RAM**: 8 GB
- **Disk**: 40 GB NVMe SSD
- **OS**: Ubuntu 22.04 LTS

### Программное обеспечение
- Docker 24+
- Docker Compose v2+
- Git
- Node.js 20+ (для локальной разработки)

---

## 🏗️ Архитектура

```
Internet
   ↓
[Traefik Reverse Proxy]  ← Порты 80/443 (SSL/TLS)
   ↓
[wa-manager Container]   ← Внутренний порт 3000 (Next.js)
   │                        Внутренний порт 5001 (API + WebSocket)
   ├→ [PostgreSQL]         ← Внутренняя сеть (порт закрыт!)
   └→ [Redis]              ← Внутренняя сеть (порт закрыт!)
```

### Безопасность

✅ **Все порты закрыты**, кроме:
- 22 (SSH)
- 80 (HTTP → redirect to HTTPS)
- 443 (HTTPS)

✅ **PostgreSQL и Redis** - только внутри Docker сети
✅ **SSL/TLS** - автоматически через Let's Encrypt
✅ **WebSocket** - полностью защищен через HTTPS
✅ **Docker Security** - минимальные capabilities, no-new-privileges

---

## 🔧 Подготовка VPS

### 1. Подключение к VPS

```bash
ssh root@your-vps-ip
```

### 2. Создание пользователя (не используйте root!)

```bash
# Создать пользователя
adduser deployer
usermod -aG sudo deployer

# Добавить SSH ключ
mkdir -p /home/deployer/.ssh
cp ~/.ssh/authorized_keys /home/deployer/.ssh/
chown -R deployer:deployer /home/deployer/.ssh
chmod 700 /home/deployer/.ssh
chmod 600 /home/deployer/.ssh/authorized_keys

# Переключиться на нового пользователя
su - deployer
```

### 3. Установка Docker

```bash
# Обновить систему
sudo apt update && sudo apt upgrade -y

# Установить зависимости
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common git

# Установить Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Добавить пользователя в группу docker
sudo usermod -aG docker $USER

# Применить изменения
newgrp docker

# Проверить установку
docker --version
docker compose version
```

### 4. Настройка Firewall

```bash
# Установить UFW
sudo apt install -y ufw

# Разрешить необходимые порты
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS

# Включить firewall
sudo ufw --force enable

# Проверить статус
sudo ufw status
```

---

## 📦 Установка

### 1. Клонирование репозитория

```bash
cd ~
git clone <your-repo-url> wa-manager
cd wa-manager
```

### 2. Настройка переменных окружения

```bash
# Создать .env файл
cp .env.example .env

# Редактировать .env
nano .env
```

**Обязательные переменные:**

```env
# Database
DATABASE_URL="postgresql://postgres:CHANGE_ME@postgres:5432/wa_manager?schema=public&connection_limit=10&pool_timeout=10&connect_timeout=30"
DIRECT_URL="postgresql://postgres:CHANGE_ME@postgres:5432/wa_manager?schema=public"

# Application URLs (замените на ваш домен!)
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_API_URL=https://your-domain.com

# API
API_PORT=5001
API_SECRET_KEY=GENERATE_RANDOM_STRING_HERE

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=GENERATE_RANDOM_PASSWORD_HERE

# Node
NODE_ENV=production

# Telegram (опционально)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

**Генерация секретных ключей:**

```bash
# Генерировать случайный ключ для API_SECRET_KEY
openssl rand -base64 32

# Генерировать пароль для Redis
openssl rand -base64 24
```

### 3. Настройка DNS

В вашем DNS провайдере создайте A запись:

```
Type: A
Name: @ (или your-subdomain)
Value: <ваш-VPS-IP>
TTL: 300
```

Подождите 5-10 минут для распространения DNS.

### 4. Запуск deployment

```bash
# Сделать скрипт исполняемым
chmod +x deploy.sh

# Запустить deployment
./deploy.sh
```

Скрипт автоматически:
- Создаст конфигурацию Traefik
- Настроит SSL сертификаты (Let's Encrypt)
- Соберет Docker образы
- Запустит все сервисы
- Настроит firewall

### 5. Проверка установки

```bash
# Проверить статус контейнеров
docker compose ps

# Все должны быть в статусе "healthy" или "running"
```

Проверьте доступность:
- Откройте https://your-domain.com в браузере
- Должно работать с HTTPS (зеленый замок)

---

## ⚙️ Настройка

### Docker Compose файлы

Проект использует `docker-compose.yml` для production. Все порты баз данных **закрыты**:

```yaml
# PostgreSQL - только внутренняя сеть
expose:
  - "5432"  # НЕТ внешних портов!

# Redis - только внутренняя сеть
expose:
  - "6379"  # НЕТ внешних портов!
```

### Настройка Traefik

Файл `traefik/traefik.yml`:
- Автоматический SSL через Let's Encrypt
- HTTP → HTTPS redirect
- WebSocket support
- Rate limiting
- Security headers

### Обновление приложения

```bash
# Перейти в директорию
cd ~/wa-manager

# Получить последние изменения
git pull

# Перезапустить
./deploy.sh
```

---

## 🔌 WebSocket API

Приложение использует **полностью WebSocket архитектуру** для real-time коммуникации.

### Namespaces

#### `/accounts` - Управление аккаунтами

```typescript
import { accountsSocket } from '@/lib/socket';

// Получить все аккаунты
const { data } = await accountsSocket.list();

// Создать аккаунт
await accountsSocket.create('Account Name', true);

// Подключить аккаунт
await accountsSocket.connect(accountId);

// Подписаться на обновления статуса
accountsSocket.onStatusUpdate((data) => {
  console.log('Status updated:', data);
});
```

#### `/chats` - Чаты и сообщения

```typescript
import { chatsSocket } from '@/lib/socket';

// Получить чаты
const { data } = await chatsSocket.list(accountId);

// Отправить сообщение
await chatsSocket.send(accountId, phoneNumber, message);

// Подписаться на новые сообщения
chatsSocket.onNewMessage((data) => {
  console.log('New message:', data);
});
```

#### `/qr` - QR коды

```typescript
import { qrSocket } from '@/lib/socket';

// Подписаться на QR коды
qrSocket.join(accountId);

qrSocket.onGenerated((data) => {
  console.log('QR Code:', data.qrCode);
});
```

### События в реальном времени

Все изменения передаются мгновенно через WebSocket:
- ✅ Статусы аккаунтов
- ✅ Новые сообщения
- ✅ QR коды
- ✅ Обновления очереди

---

## 🔒 Безопасность

### 1. Закрытые порты

PostgreSQL и Redis **НЕ доступны снаружи**. Только через внутреннюю Docker сеть.

### 2. SSL/TLS

Автоматические сертификаты Let's Encrypt:
- Автообновление каждые 60 дней
- TLS 1.2/1.3
- Сильные cipher suites

### 3. Docker Security

Все контейнеры используют:
```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
cap_add:
  - NET_BIND_SERVICE  # только для Traefik
```

### 4. Защита от вирусов

В `docker-compose.yml` уже настроена блокировка вредоносных доменов:

```yaml
extra_hosts:
  - "repositorylinux.publicvm.com:127.0.0.1"
  - "publicvm.com:127.0.0.1"
```

### 5. Рекомендации

✅ Измените пароль PostgreSQL
✅ Используйте сильный API_SECRET_KEY
✅ Настройте регулярные бэкапы
✅ Обновляйте систему: `sudo apt update && sudo apt upgrade`
✅ Мониторьте логи: `docker compose logs -f`

---

## 📊 Мониторинг

### Просмотр логов

```bash
# Все сервисы
docker compose logs -f

# Конкретный сервис
docker compose logs -f wa-manager
docker compose logs -f traefik
docker compose logs -f postgres
docker compose logs -f redis

# Последние 100 строк
docker compose logs --tail=100 wa-manager
```

### Проверка здоровья

```bash
# Health check API
curl https://your-domain.com/api/health

# WebSocket health
curl https://your-domain.com/api/health/websocket

# Статус Docker
docker compose ps

# Использование ресурсов
docker stats
```

### Метрики

```bash
# Использование диска
df -h

# Использование памяти
free -h

# Активные подключения
docker exec wa-manager sh -c "curl -s localhost:5001/health | jq '.activeClients'"
```

---

## 🔧 Troubleshooting

### Проблема: Контейнеры не запускаются

```bash
# Проверить логи
docker compose logs

# Перезапустить
docker compose down
docker compose up -d

# Пересобрать
docker compose build --no-cache
docker compose up -d
```

### Проблема: SSL сертификат не создается

1. Проверьте DNS: `nslookup your-domain.com`
2. Проверьте порты: `sudo netstat -tlnp | grep -E '80|443'`
3. Проверьте Traefik логи: `docker compose logs traefik`
4. Убедитесь что домен указывает на ваш VPS IP

### Проблема: WebSocket не работает

1. Проверьте URL в .env: `NEXT_PUBLIC_API_URL=https://your-domain.com`
2. Проверьте Traefik labels в docker-compose.yml
3. Проверьте браузерную консоль на ошибки WebSocket
4. Проверьте: `curl https://your-domain.com/socket.io/`

### Проблема: PostgreSQL connection errors

```bash
# Проверить что PostgreSQL работает
docker exec wa-postgres pg_isready -U postgres

# Проверить переменные окружения
docker exec wa-manager env | grep DATABASE_URL

# Переподключиться к БД
docker compose restart wa-manager
```

### Проблема: Высокое потребление памяти

```bash
# Проверить memory limits в docker-compose.yml
# Они должны быть настроены:
deploy:
  resources:
    limits:
      memory: 6144M
```

---

## 📁 Структура проекта

```
wa-manager/
├── server/                    # Backend API
│   ├── index.js              # Main server
│   ├── socket/               # WebSocket namespaces
│   │   ├── namespaces/
│   │   │   ├── accounts.js   # Accounts WebSocket API
│   │   │   ├── chats.js      # Chats WebSocket API
│   │   │   └── qr.js         # QR WebSocket API
│   │   └── index.js          # Socket.IO initialization
│   ├── queue.js              # BullMQ queues
│   └── workers.js            # Background workers
├── app/                       # Next.js frontend
├── lib/                       # Client libraries
│   └── socket.ts             # WebSocket client
├── docker-compose.yml        # Production config
├── Dockerfile                # Application image
├── deploy.sh                 # Deployment script
└── .env                      # Environment variables
```

---

## 🎯 Best Practices

### 1. Бэкапы

Настройте автоматические бэкапы PostgreSQL:

```bash
# Создать backup скрипт
cat > ~/backup-db.sh <<'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
docker exec wa-postgres pg_dump -U postgres wa_manager | gzip > ~/backups/wa_manager_$DATE.sql.gz
# Удалить бэкапы старше 7 дней
find ~/backups -name "wa_manager_*.sql.gz" -mtime +7 -delete
EOF

chmod +x ~/backup-db.sh

# Добавить в crontab (каждый день в 3:00)
crontab -e
# 0 3 * * * /home/deployer/backup-db.sh
```

### 2. Обновления системы

```bash
# Настроить auto-updates
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 3. Мониторинг дискового пространства

```bash
# Очистка Docker
docker system prune -a --volumes -f

# Ротация логов
docker compose logs --tail=1000 wa-manager > /dev/null
```

---

## 📞 Поддержка

При проблемах:

1. Проверьте логи: `docker compose logs`
2. Проверьте health: `curl localhost:5001/health`
3. Проверьте GitHub Issues
4. Создайте новый Issue с описанием проблемы и логами

---

## ✅ Checklist финального деплоя

- [ ] VPS с Ubuntu 22.04 настроен
- [ ] Пользователь (не root) создан
- [ ] Docker и Docker Compose установлены
- [ ] Firewall настроен (UFW)
- [ ] Домен настроен и DNS записи созданы
- [ ] `.env` файл заполнен с сильными паролями
- [ ] `deploy.sh` выполнен успешно
- [ ] HTTPS работает (зеленый замок в браузере)
- [ ] WebSocket подключается
- [ ] PostgreSQL доступен только внутри Docker
- [ ] Redis доступен только внутри Docker
- [ ] Бэкапы настроены
- [ ] Логи проверены

---

## 🚀 Готово!

Ваш WhatsApp Manager развернут и защищен!

**URL**: https://your-domain.com
**API**: https://your-domain.com (REST + WebSocket)

Все внутренние сервисы защищены, только Traefik имеет доступ наружу через порты 80/443.

**Безопасность**: ✅ PostgreSQL закрыт
**Безопасность**: ✅ Redis закрыт
**Безопасность**: ✅ SSL/TLS настроен
**Безопасность**: ✅ WebSocket защищен
**Безопасность**: ✅ Docker hardened

Наслаждайтесь! 🎉
