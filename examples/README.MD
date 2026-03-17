# YDB JavaScript SDK Examples / Примеры

This folder contains runnable examples for YDB JavaScript SDK. Each example is a small npm package you can copy as a starter.

Эта папка содержит примеры использования YDB JavaScript SDK. Каждый пример — отдельный npm‑пакет, который можно скопировать как стартовый шаблон.

> **💡 Looking for more examples?** Check out the [ydb-js-examples](https://github.com/ydb-platform/ydb-js-examples) repository for comprehensive real-world examples and use cases.
>
> **💡 Ищете больше примеров?** Посмотрите репозиторий [ydb-js-examples](https://github.com/ydb-platform/ydb-js-examples) с полным набором примеров реальных сценариев использования.

## 📦 Examples / Примеры

### 📁 [api/](./api/)

EN: Low‑level API usage (Discovery, Scheme), basic auth.

RU: Пример низкоуровневого API (Discovery, Scheme), базовая аутентификация.

```bash
cd examples/api
npm install && npm start
```

### 📁 [query/](./query/)

EN: SQL queries, parameters, basic DDL/DML, results.

RU: SQL‑запросы, параметры, базовый DDL/DML, обработка результатов.

```bash
cd examples/query
npm install && npm start
```

### 📁 [sls/](./sls/)

EN: Serverless considerations (HTTP/2, driver lifecycle inside handler).

RU: Serverless‑сценарии (HTTP/2, жизненный цикл драйвера внутри handler).

```bash
cd examples/sls
npm install && npm start
```

### 📁 [tls/](./tls/)

EN: TLS with custom CA, mTLS (client cert+key), StaticCredentialsProvider over TLS/mTLS.

RU: TLS с кастомным CA, mTLS (client cert+key), StaticCredentialsProvider по TLS/mTLS.

```bash
cd examples/tls
npm install && npm start
```

### 📁 [topic/](./topic/)

EN: Topic reader/writer and transactional usage

RU: Topic reader/writer и транзакционное использование

```bash
cd examples/topic
npm install && npm start
```

### 📁 [coordination/](./coordination/)

EN: Coordination nodes, distributed semaphores, leader election

RU: Coordination nodes, распределенные семафоры, выбор лидера

```bash
cd examples/coordination
npm install && npm start
```

### 📁 [fsm/](./fsm/)

EN: Lightweight async-first FSM runtime usage (`@ydbjs/fsm`), transitions, effects, stream ingestion.

RU: Использование легковесного async-first FSM runtime (`@ydbjs/fsm`), переходы, эффекты, ingestion стримов.

```bash
cd examples/fsm
npm install && npm start
```

### 📁 [service-account/](./service-account/)

EN: Yandex Cloud Service Account authentication with authorized key JSON file.

RU: Авторизация через Yandex Cloud Service Account с использованием authorized key JSON файла.

```bash
cd examples/service-account
npm install && npm start
```

## 🚀 DevContainer

EN: Easiest way to try; spins up YDB and sets env for you.

RU: Проще всего запустить в DevContainer — поднимет YDB и настроит окружение.

Requirements / Требования:

- VS Code, Docker, Dev Containers extension

Run / Запуск:

1. Reopen in Container
2. Wait for build to finish

## 🔧 Manual setup / Ручная настройка

1. Start YDB (Docker)

```bash
docker run -d --rm --name ydb-local -h localhost \
  --platform linux/amd64 \
  -p 2135:2135 -p 2136:2136 -p 8765:8765 -p 9092:9092 \
  -e GRPC_TLS_PORT=2135 -e GRPC_PORT=2136 -e MON_PORT=8765 \
  -e YDB_KAFKA_PROXY_PORT=9092 \
  ydbplatform/local-ydb:latest
```

2. Env / Переменные

```bash
export YDB_CONNECTION_STRING="grpc://localhost:2136/local"
```

## ▶️ Run examples / Запуск примеров

```bash
cd examples/api && npm start
cd examples/query && npm run dev
cd examples/sls && npm start
cd examples/tls && npm start
cd examples/topic && npm start
cd examples/coordination && npm start
cd examples/fsm && npm start
cd examples/service-account && npm start
```

## 💡 Tips / Советы

- Start with `examples/query/`
- Use `npm run dev` for verbose logs (`DEBUG=ydbjs:*`)
- DevContainer exposes Web UI at http://localhost:8765
- You can copy any example as a template
