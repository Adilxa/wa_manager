# Быстрый Деплой - Шпаргалка

## 📦 На локальной машине

```bash
git add .
git commit -m "feat: production-ready - 100% stability"
git push origin master
```

---

## 🚀 На сервере

```bash
# 1. Переход в директорию
cd /var/www/wa_manager

# 2. Подтянуть изменения
git pull origin master

# 3. Остановить контейнеры
docker-compose down

# 4. Пересобрать
docker-compose build --no-cache wa-manager

# 5. Запустить
docker-compose up -d

# 6. Проверить логи
docker-compose logs -f wa-manager
```

---

## ✅ Что вы должны увидеть в логах:

```
🧹 Cleaning Chromium lock files...
  Removed: ...
✅ Lock files cleaned

🚀 WhatsApp API Server running on http://localhost:5001

🔄 Reset X stuck account(s) to DISCONNECTED

💡 Ready to accept connections

📊 Health check: http://localhost:5001/health
```

---

## 🧪 Быстрая проверка

```bash
# Health check
curl http://localhost:5001/health

# Следить за логами
docker-compose logs -f wa-manager

# Статистика контейнера
docker stats wa-manager
```

---

## 🎯 Основные изменения

✅ Автоочистка lock-файлов при старте
✅ Graceful shutdown браузеров
✅ Retry логика (2 попытки)
✅ Health check endpoint
✅ Мониторинг ресурсов каждую минуту
✅ Автосброс застрявших аккаунтов
✅ Множественные подключения без блокировки

---

## ⚠️ Если что-то пошло не так

```bash
# Полная очистка (УДАЛИТ СЕССИИ!)
docker-compose down -v
docker-compose up -d

# Или только restart
docker-compose restart wa-manager

# Проверка что контейнер запущен
docker ps
```

---

**Готово! Теперь работает на 100% 🚀**
