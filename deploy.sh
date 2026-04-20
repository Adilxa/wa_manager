#!/bin/bash

# Скрипт автоматического деплоя WhatsApp Manager на VPS Ubuntu
# Использование: bash deploy.sh

set -e  # Прервать выполнение при любой ошибке

echo "================================"
echo "WhatsApp Manager - Deployment"
echo "================================"
echo ""

# Проверка наличия Docker
if ! command -v docker &> /dev/null; then
    echo "Docker не установлен. Устанавливаем..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    echo "✓ Docker установлен!"
else
    echo "✓ Docker уже установлен"
fi

# Проверка наличия Docker Compose
if docker compose version &> /dev/null; then
    COMPOSE=(docker compose)
    echo "✓ Docker Compose уже установлен"
elif command -v docker-compose &> /dev/null; then
    COMPOSE=(docker-compose)
    echo "✓ Docker Compose уже установлен"
else
    echo "Docker Compose не установлен. Устанавливаем..."
    sudo apt-get update
    sudo apt-get install -y docker-compose-plugin
    COMPOSE=(docker compose)
    echo "✓ Docker Compose установлен!"
fi

echo ""
echo "================================"
echo "Настройка переменных окружения"
echo "================================"

# Проверка наличия .env файла
if [ ! -f .env ]; then
    echo "⚠ Файл .env не найден. Создаем из .env.example..."

    if [ -f .env.example ]; then
        cp .env.example .env
        echo ""
        echo "⚠ ВАЖНО: Отредактируйте файл .env перед продолжением!"
        echo "   Необходимо настроить:"
        echo "   - NEXT_PUBLIC_APP_URL (публичный URL вашего приложения)"
        echo "   - NEXT_PUBLIC_API_URL (публичный URL вашего API)"
        echo "   - API_SECRET_KEY (случайный секретный ключ)"
        echo ""
        echo "   Для локальной БД PostgreSQL можно оставить DATABASE_URL как есть"
        echo ""
        read -p "Нажмите Enter после редактирования .env файла..."
    else
        echo "❌ Файл .env.example не найден!"
        exit 1
    fi
else
    echo "✓ Файл .env найден"
fi

echo ""
echo "================================"
echo "Остановка старых контейнеров"
echo "================================"

# Останавливаем и удаляем старые контейнеры
if [ "$(docker ps -q -f name=wa-manager)" ] || [ "$(docker ps -q -f name=wa-postgres)" ]; then
    echo "Останавливаем работающие контейнеры..."
    "${COMPOSE[@]}" down
else
    echo "✓ Нет работающих контейнеров"
fi

echo ""
echo "================================"
echo "Сборка и запуск контейнеров"
echo "================================"

# Собираем и запускаем контейнеры
echo "Собираем Docker образ..."
"${COMPOSE[@]}" build --no-cache

echo "Запускаем контейнеры (PostgreSQL + WhatsApp Manager)..."
"${COMPOSE[@]}" up -d

echo ""
echo "================================"
echo "Проверка статуса"
echo "================================"

# Ждем несколько секунд для запуска контейнеров
echo "Ожидание запуска контейнеров (15 секунд)..."
sleep 15

# Проверяем статус контейнеров
echo ""
echo "Статус контейнеров:"
"${COMPOSE[@]}" ps

echo ""
echo "Проверка PostgreSQL..."
if "${COMPOSE[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /dev/null 2>&1; then
    echo "✓ PostgreSQL работает"
else
    echo "⚠ PostgreSQL еще запускается..."
fi

echo ""
echo "================================"
echo "Настройка Firewall (UFW)"
echo "================================"

if command -v ufw &> /dev/null; then
    echo "Открываем необходимые порты..."
    sudo ufw allow 22/tcp      # SSH
    sudo ufw allow 80/tcp      # HTTP
    sudo ufw allow 443/tcp     # HTTPS

    # Активируем UFW если не активен
    sudo ufw --force enable

    echo "✓ Firewall настроен"
    sudo ufw status
else
    echo "⚠ UFW не установлен. Рекомендуется установить для безопасности:"
    echo "   sudo apt-get install ufw"
fi

echo ""
echo "================================"
echo "Деплой завершен!"
echo "================================"
echo ""
echo "Приложение доступно по адресам:"
echo "  UI:  http://$(hostname -I | awk '{print $1}'):3000"
echo "  API: http://$(hostname -I | awk '{print $1}'):5001"
echo ""
echo "Для просмотра логов:"
echo "  ${COMPOSE[*]} logs -f"
echo ""
echo "Логи конкретных сервисов:"
echo "  ${COMPOSE[*]} logs -f wa-manager"
echo "  ${COMPOSE[*]} logs -f postgres"
echo ""
echo "Для остановки:"
echo "  ${COMPOSE[*]} down"
echo ""
echo "Для перезапуска:"
echo "  ${COMPOSE[*]} restart"
echo ""
echo "⚠ РЕКОМЕНДАЦИИ ДЛЯ PRODUCTION:"
echo "   1. Измените POSTGRES_PASSWORD и DATABASE_URL/DIRECT_URL в .env"
echo "   2. Используйте сильный API_SECRET_KEY в .env"
echo "   3. Настройте Nginx с SSL (см. README-DEPLOY.md)"
echo "   4. Настройте регулярное резервное копирование БД"
echo ""
