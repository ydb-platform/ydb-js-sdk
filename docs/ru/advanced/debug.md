---
title: Debug‑логирование
---

# Debug‑логирование

SDK использует структурированный логгер из пакета `@ydbjs/debug`. Управление выводом — через стандартную переменную окружения `DEBUG`.

## Пакеты и пространства имён

- `ydbjs:driver:*` — внутренности драйвера (соединения, discovery, middleware)
- `ydbjs:query:*` — клиент Query (текст SQL, повторы, статистика)
- `ydbjs:topic:*` — Topic reader/writer (стриминг, коммиты, acks)
- `ydbjs:retry:*` — решения ретраев
- `ydbjs:error:*` — классификация и упаковка ошибок

## Включение логов

```bash
# включить все логи
DEBUG=ydbjs:* node app.js

# только логи topic
DEBUG=ydbjs:topic:* node app.js

# конкретный компонент (topic writer)
DEBUG=ydbjs:topic:writer node app.js
```

В Docker/Kubernetes задайте `DEBUG` в env контейнера. В NestJS/Next.js — экспортируйте `DEBUG` перед запуском сервера разработки.

## Использование логгера в коде

```ts
import { loggers } from '@ydbjs/debug'

const dbg = loggers.topic.extend('writer')

dbg.log('creating writer with producer: %s', producerId)
```

Можно создавать собственные ветки имён и переиспользовать их в модулях.

## Пример вывода

```
ydbjs:topic:writer creating writer with producer: my-producer +0ms
ydbjs:topic:writer connecting to topic service +2ms
ydbjs:topic:writer connected successfully +45ms
```

Совет: добавляйте correlation ID приложения в сообщения, чтобы удобно трассировать потоки между сервисами.
