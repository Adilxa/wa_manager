# WhatsApp Manager - Развертывание на VPS

## Настроенные порты
- **3000** - Next.js UI (веб-интерфейс)
- **5001** - WhatsApp API (сервер)
- **5432** - PostgreSQL (база данных)

## Быстрый старт

### 1. Подключитесь к VPS
```bash
ssh user@your-server-ip
```

### 2. Клонируйте репозиторий
```bash
git clone <your-repo-url> wa-manager
cd wa-manager
```

### 3. Настройте .env
```bash
cp .env.example .env
nano .env
```

**Обязательно измените:**
- `DATABASE_URL` - будет использована локальная PostgreSQL в Docker (можете оставить как в примере)
- `DIRECT_URL` - будет использована локальная PostgreSQL в Docker (можете оставить как в примере)
- `NEXT_PUBLIC_APP_URL` - http://ваш-ip:3000 (или ваш домен)
- `NEXT_PUBLIC_API_URL` - http://ваш-ip:5001 (или ваш домен)
- `API_SECRET_KEY` - случайный секретный ключ (сгенерируйте надежный)

**Пример для production:**
```bash
DATABASE_URL="postgresql://postgres:postgres@postgres:5432/wa_manager?schema=public"
DIRECT_URL="postgresql://postgres:postgres@postgres:5432/wa_manager?schema=public"
NEXT_PUBLIC_APP_URL=http://your-domain.com
NEXT_PUBLIC_API_URL=http://your-domain.com/api
API_SECRET_KEY=your-super-secret-key-change-this-in-production
NODE_ENV=production
```

### 4. Запустите автоматический деплой
```bash
chmod +x deploy.sh
bash deploy.sh
```

### 5. Проверьте работу
```bash
# Статус контейнеров
docker-compose ps

# Логи
docker-compose logs -f

# Тест UI
curl http://localhost:3000

# Тест API
curl http://localhost:5001/api/accounts
```

## Доступ к приложению

После успешного деплоя приложение будет доступно:
- **UI**: http://ваш-ip-сервера:3000
- **API**: http://ваш-ip-сервера:5001

## База данных

Проект использует **локальную PostgreSQL базу данных в Docker контейнере**:
- Данные сохраняются в Docker volume `postgres_data`
- Автоматическое создание БД при первом запуске
- Автоматическое применение миграций Prisma при запуске приложения
- Не требуется внешний Supabase или другой PostgreSQL сервер

### Подключение к БД из хоста (опционально)
```bash
# Установите psql клиент
sudo apt-get install postgresql-client

# Подключитесь к БД
psql -h localhost -p 5432 -U postgres -d wa_manager
# Пароль: postgres
```

### Резервное копирование БД
```bash
# Создать бэкап
docker-compose exec postgres pg_dump -U postgres wa_manager > backup.sql

# Восстановить из бэкапа
cat backup.sql | docker-compose exec -T postgres psql -U postgres wa_manager
```

## Управление

```bash
# Просмотр логов
docker-compose logs -f

# Просмотр логов конкретного сервиса
docker-compose logs -f wa-manager
docker-compose logs -f postgres

# Перезапуск
docker-compose restart

# Остановка
docker-compose down

# Остановка с удалением volumes (ВНИМАНИЕ: удалит данные БД!)
docker-compose down -v

# Обновление
git pull
docker-compose up -d --build
```

## Что делает deploy.sh?

1. Проверяет и устанавливает Docker
2. Проверяет и устанавливает Docker Compose
3. Создает .env из примера (если не существует)
4. Останавливает старые контейнеры
5. Собирает Docker образ
6. Запускает контейнеры (PostgreSQL + WhatsApp Manager)
7. Настраивает firewall (открывает порты 22, 80, 443, 3000, 5001, 5432)

## Требования

- Ubuntu 18.04+ (или другая Linux система)
- Минимум 2GB RAM (рекомендуется 4GB)
- Минимум 20GB свободного места на диске
- Docker и Docker Compose (установятся автоматически скриптом)

## Проблемы?

Если возникли проблемы:

1. **Проверьте логи:**
   ```bash
   docker-compose logs -f
   ```

2. **Проверьте порты:**
   ```bash
   sudo lsof -i :3000
   sudo lsof -i :5001
   sudo lsof -i :5432
   ```

3. **Проверьте .env файл:**
   ```bash
   cat .env
   ```

4. **Убедитесь что БД доступна:**
   ```bash
   docker-compose exec postgres pg_isready -U postgres
   ```

5. **Проверьте состояние контейнеров:**
   ```bash
   docker-compose ps
   docker stats
   ```

6. **Пересоздайте контейнеры:**
   ```bash
   docker-compose down
   docker-compose up -d --build
   ```

## Production настройка с Nginx и SSL

### 1. Установите Nginx
```bash
sudo apt-get update
sudo apt-get install nginx
```

### 2. Создайте конфигурацию
```bash
sudo nano /etc/nginx/sites-available/wa-manager
```

Добавьте конфигурацию:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 100M;

    # UI (Next.js)
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API
    location /api {
        proxy_pass http://localhost:5001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Активируйте конфигурацию
```bash
sudo ln -s /etc/nginx/sites-available/wa-manager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. Установите SSL с Certbot
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 5. Обновите .env
```bash
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_API_URL=https://your-domain.com/api
```

### 6. Перезапустите приложение
```bash
docker-compose restart
```

## Автоматические обновления

Создайте скрипт для автоматического обновления:

```bash
nano update.sh
```

```bash
#!/bin/bash
cd /path/to/wa-manager
git pull
docker-compose up -d --build
docker-compose logs -f
```

```bash
chmod +x update.sh
```

## Мониторинг

### Установка Portainer (опционально)
```bash
docker volume create portainer_data
docker run -d -p 9000:9000 --name portainer --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Доступ: http://ваш-ip:9000

## Безопасность

1. **Измените пароль PostgreSQL** в docker-compose.yml (переменные POSTGRES_PASSWORD)
2. **Используйте сильный API_SECRET_KEY** в .env
3. **Настройте firewall** (UFW делает это автоматически в deploy.sh)
4. **Используйте SSL** в production (см. секцию Nginx)
5. **Регулярно обновляйте** систему и Docker образы
6. **Настройте резервное копирование** БД

## Поддержка

Если возникли вопросы или проблемы, проверьте:
1. Логи контейнеров: `docker-compose logs -f`
2. Статус системы: `docker stats`
3. Доступность портов: `netstat -tulpn | grep -E '(3000|5001|5432)'`
4. Состояние БД: `docker-compose exec postgres pg_isready -U postgres`
