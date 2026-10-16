## Lending Bot (BASE & OPT)
Автоматизированный бот для мониторинга ликвидности на Moonwell и проведения обменов через 0x API / Li.Fi.
## 🛠 Установка и настройка

1. Установка зависимостей

npm install# Для запуска используйте tsx (поддерживает ESM и TypeScript из коробки)
npx tsx index.ts
или из команды cmd:
set KEY_PASSWORD=<somepass>&& npx tsx index.ts

2. Фиксация версий
   Для стабильности на тестовом стенде версии зафиксированы в package.json (без символа ^). Рекомендуется устанавливать через:

npm ci

в package.json прописано "ethers": "6.16.0" (вместо "ethers": "^6.16.0")


## 🔐 Безопасность и хранение ключей
Проект настроен на работу с зашифрованным хранилищем JSON Keystore, чтобы приватный ключ не хранился в открытом виде.
## 1. Генерация Keystore
Если у вас еще нет .env/ENCRYPTED_KEY, создайте его один раз:

* Вставьте приватный ключ в скрипт генерации `createKeystore.ts`.
* Укажите надежный пароль.
* Выполните скрипт и удалите исходный ключ.
* Теперь wallet получаем из .env/ENCRYPTED_KEY и пароля (.env/KEY_PASSWORD ?? ввод в консоли)

## 2. Запуск бота
При старте бот потребует ввод пароля в консоли для расшифровки ключа в оперативной памяти. Это защищает средства в случае кражи файла .env 
## ⚙️ Конфигурация (.env)
Создайте файл .env в корне проекта:

см. .env.example
# PRIVATE_KEY не используется в открытом виде!

## 🚀 Основной функционал

* Moonwell Monitor: Проверка доступной ликвидности и риска ликвидации (shortfall) в сетях BASE/OPT.
* Moonwell Transactions - withdraw, repay, borrow, supply

## Position classes

`classes/Position.ts` defines the shared position contract and `LENDING_BOT_URL`.
`MoonwellPosition`, `MorphoPosition`, and `HLPosition` implement position retrieval and reporting.
Moonwell additionally exposes `getRecommend()`, `loop(amount)`, and `deLoop(amount)`.
Hyperliquid reports its generated lending model to the console only.
