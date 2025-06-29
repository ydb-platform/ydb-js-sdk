# YDB JavaScript SDK Examples

Эта папка содержит примеры использования YDB JavaScript SDK. Каждый пример оформлен как отдельный npm-пакет, который можно легко скопировать и использовать в качестве стартового шаблона для ваших проектов.

## 📦 Доступные примеры

### 📁 **[api/](./api/)**

Пример использования низкоуровневого API для работы с YDB:

- Подключение к базе данных
- Использование Discovery Service
- Проверка соединения с помощью WhoAmI

```bash
cd examples/api
npm install && npm start
```

### 📁 **[query/](./query/)**

Пример выполнения SQL-запросов:

- Создание и выполнение SQL-запросов
- Работа с параметрами запросов
- Создание таблиц и индексов
- Обработка результатов

```bash
cd examples/query
npm install && npm start
```

### 📁 **[sls/](./sls/)**

Примеры для Serverless функций (AWS Lambda, Yandex Cloud Functions, Vercel Functions и подобных):

- Правильная работа с HTTP/2 соединениями в serverless
- Создание драйвера внутри handler функции
- Корректное управление жизненным циклом соединений

```bash
cd examples/sls
npm install && npm start
```

## 🚀 Быстрый старт с DevContainer

Самый простой способ попробовать примеры — использовать DevContainer. Он автоматически настроит окружение с YDB и всеми необходимыми зависимостями.

### Требования

- [Visual Studio Code](https://code.visualstudio.com/)
- [Docker](https://www.docker.com/)
- Расширение [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) для VS Code

### Запуск

1. Откройте проект в VS Code
2. Нажмите `Ctrl+Shift+P` (или `Cmd+Shift+P` на Mac)
3. Выберите **"Dev Containers: Reopen in Container"**
4. Дождитесь окончания сборки контейнера (это может занять несколько минут при первом запуске)

После запуска DevContainer у вас будет:

- ✅ Локальная база данных YDB
- ✅ Все необходимые зависимости
- ✅ Правильно настроенные переменные окружения

## 🔧 Ручная настройка

Если вы предпочитаете запускать примеры локально без DevContainer:

### 1. Установите YDB

```bash
# Создайте директорию для YDB (опционально, для сохранения данных)
mkdir ~/ydbd && cd ~/ydbd
mkdir ydb_data
mkdir ydb_certs

# Запустите YDB в Docker контейнере
docker run -d --rm --name ydb-local -h localhost \
  --platform linux/amd64 \
  -p 2135:2135 -p 2136:2136 -p 8765:8765 -p 9092:9092 \
  -v $(pwd)/ydb_certs:/ydb_certs -v $(pwd)/ydb_data:/ydb_data \
  -e GRPC_TLS_PORT=2135 -e GRPC_PORT=2136 -e MON_PORT=8765 \
  -e YDB_KAFKA_PROXY_PORT=9092 \
  ydbplatform/local-ydb:latest
```

> **Примечание:** Если вам не нужно сохранять данные между перезапусками контейнера, можно запустить YDB без volume:
>
> ```bash
> docker run -d --rm --name ydb-local -h localhost \
>   --platform linux/amd64 \
>   -p 2135:2135 -p 2136:2136 -p 8765:8765 -p 9092:9092 \
>   -e GRPC_TLS_PORT=2135 -e GRPC_PORT=2136 -e MON_PORT=8765 \
>   -e YDB_KAFKA_PROXY_PORT=9092 \
>   ydbplatform/local-ydb:latest
> ```

### 2. Выберите пример и установите зависимости

```bash
# Перейдите в папку с нужным примером
cd examples/query  # или api, retry, sls

# Установите зависимости
npm install
```

### 3. Настройте переменные окружения

```bash
export YDB_CONNECTION_STRING="grpc://localhost:2136/local"
```

## ▶️ Запуск примеров

После настройки окружения вы можете запускать любой пример:

```bash
# Перейдите в папку с примером и запустите
cd examples/api && npm start

# Или с отладочной информацией
cd examples/query && npm run dev

# Serverless пример
cd examples/sls && npm start
```

## 📋 Использование как шаблон

Каждый пример можно легко скопировать и использовать как основу для вашего проекта:

```bash
# Скопируйте нужный пример
cp -r examples/query my-ydb-project
cd my-ydb-project

# Настройте под ваши нужды
npm install
# Отредактируйте index.js
npm start
```

### Отладка

Каждый пример поддерживает отладочный режим через npm script:

```bash
# Перейдите в нужный пример и запустите с отладкой
cd examples/query
npm run dev  # эквивалентно DEBUG=ydbjs:* npm start
```

## 📖 Дополнительная информация

- [Официальная документация YDB](https://ydb.tech/docs/)
- [YDB JavaScript SDK документация](https://github.com/ydb-platform/ydb-js-sdk)
- [Примеры использования](https://ydb.tech/docs/en/reference/ydb-sdk/example/)

## 💡 Советы

- Начните с `examples/query/` — это наиболее распространенный сценарий использования
- Используйте `npm run dev` для отладки проблем с подключением
- В DevContainer YDB доступна по адресу `grpc://localhost:2136/local`
- Web UI YDB доступен по адресу http://localhost:8765 (в DevContainer)
- Каждый пример имеет собственный README.md с подробными инструкциями
- Вы можете легко копировать любой пример как стартовый шаблон для своего проекта
