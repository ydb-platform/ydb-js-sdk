# YDB JavaScript SDK Examples / Примеры

This folder contains runnable examples for YDB JavaScript SDK. Each example is a small npm package you can copy as a starter.

Эта папка содержит примеры использования YDB JavaScript SDK. Каждый пример — отдельный npm‑пакет, который можно скопировать как стартовый шаблон.

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
```

## 💡 Tips / Советы

- Start with `examples/query/`
- Use `npm run dev` for verbose logs (`DEBUG=ydbjs:*`)
- DevContainer exposes Web UI at http://localhost:8765
- You can copy any example as a template
