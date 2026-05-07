#!/bin/bash

###############################################################################
# WhatsApp Manager - Secure VPS Deployment
#
# Безопасный deployment с полностью закрытыми внутренними сервисами
# Только Traefik имеет доступ наружу (порты 80/443)
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'  # No Color

# Print colored messages
print_msg() {
    color=$1
    shift
    echo -e "${color}$@${NC}"
}

print_msg $BLUE "
╔══════════════════════════════════════════════════════════════╗
║         WhatsApp Manager - VPS Deployment                    ║
║         Secure Docker Setup with WebSocket                   ║
╚══════════════════════════════════════════════════════════════╝
"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    print_msg $RED "⚠️  Не запускайте этот скрипт от root!"
    print_msg $YELLOW "Используйте: ./deploy.sh"
    exit 1
fi

# Check if env file exists
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ] && [ -f ".env.production" ]; then
    ENV_FILE=".env.production"
fi

if [ ! -f "$ENV_FILE" ]; then
    print_msg $RED "❌ Файл .env или .env.production не найден!"
    print_msg $YELLOW "Создайте .env.production файл с необходимыми переменными"
    exit 1
fi

# Load environment variables
print_msg $BLUE "📦 Загрузка переменных окружения из $ENV_FILE..."
set -a
. "./$ENV_FILE"
set +a

# Validate required variables
if [ -z "$NEXT_PUBLIC_APP_URL" ]; then
    print_msg $RED "❌ Не указан NEXT_PUBLIC_APP_URL в .env"
    exit 1
fi

# Create required directories
print_msg $BLUE "📁 Создание директорий..."
mkdir -p traefik logs .baileys_auth

# Create Traefik configuration
if [ ! -f traefik/traefik.yml ]; then
    print_msg $BLUE "⚙️  Создание Traefik конфигурации..."
    cat > traefik/traefik.yml <<EOF
api:
  dashboard: true
  insecure: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true

  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: wa-network
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@${NEXT_PUBLIC_APP_URL#https://}
      storage: /acme/acme.json
      tlsChallenge: true

log:
  level: INFO
  format: json
EOF
fi

# Create dynamic Traefik configuration
if [ ! -f traefik/dynamic.yml ]; then
    cat > traefik/dynamic.yml <<EOF
http:
  middlewares:
    secure-headers:
      headers:
        frameDeny: true
        sslRedirect: true
        browserXssFilter: true
        contentTypeNosniff: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 31536000

    rate-limit:
      rateLimit:
        average: 100
        burst: 50
        period: 1s

    compression:
      compress: true
EOF
fi

# Check Docker
print_msg $BLUE "🐳 Проверка Docker..."
if ! command -v docker &> /dev/null; then
    print_msg $RED "❌ Docker не установлен!"
    print_msg $YELLOW "Установите: https://docs.docker.com/engine/install/"
    exit 1
fi

# Determine Docker Compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose --env-file $ENV_FILE"
else
    DOCKER_COMPOSE="docker-compose --env-file $ENV_FILE"
fi

# Stop existing containers
print_msg $BLUE "🛑 Остановка контейнеров..."
$DOCKER_COMPOSE down || true

# Pull images
print_msg $BLUE "📥 Загрузка образов..."
$DOCKER_COMPOSE pull

# Build application
print_msg $BLUE "🔨 Сборка приложения..."
$DOCKER_COMPOSE build --no-cache

# Start services
print_msg $BLUE "🚀 Запуск сервисов..."
$DOCKER_COMPOSE up -d

# Wait for services
print_msg $BLUE "⏳ Ожидание готовности..."
sleep 10

# Health check
print_msg $BLUE "🏥 Проверка здоровья..."
for i in {1..30}; do
    if docker exec wa-manager curl -sf http://localhost:3000 -o /dev/null && \
       docker exec wa-manager curl -sf http://localhost:5001/health -o /dev/null; then
        print_msg $GREEN "✅ Сервисы готовы!"
        break
    fi
    if [ $i -eq 30 ]; then
        print_msg $RED "❌ Timeout waiting for services"
        exit 1
    fi
    echo -n "."
    sleep 2
done

# Configure firewall
print_msg $BLUE "\n🔥 Настройка Firewall..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp   # SSH
    sudo ufw allow 80/tcp   # HTTP
    sudo ufw allow 443/tcp  # HTTPS
    sudo ufw --force enable
    print_msg $GREEN "✅ Firewall настроен (только 80/443/22)"
fi

# Show status
print_msg $BLUE "\n📊 Статус контейнеров:"
$DOCKER_COMPOSE ps

print_msg $GREEN "
╔══════════════════════════════════════════════════════════════╗
║                  ✅ Deployment успешен!                      ║
╚══════════════════════════════════════════════════════════════╝

🌐 URL: $NEXT_PUBLIC_APP_URL

🔒 Безопасность:
   ✓ PostgreSQL - закрыт (внутренняя сеть)
   ✓ Redis - закрыт (внутренняя сеть)
   ✓ SSL/TLS - автоматически (Let's Encrypt)
   ✓ WebSocket - полностью настроен

📊 Команды:
   Логи:       $DOCKER_COMPOSE logs -f
   Статус:     $DOCKER_COMPOSE ps
   Стоп:       $DOCKER_COMPOSE down
   Рестарт:    $DOCKER_COMPOSE restart

🎯 Мониторинг: ./monitor.sh
"
