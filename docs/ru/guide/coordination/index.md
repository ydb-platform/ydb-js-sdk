---
title: Coordination — Обзор
---

# Coordination (@ydbjs/coordination)

Примитивы распределённой координации для YDB: семафоры, мьютексы и выборы лидера на основе узлов координации YDB.

## Быстрый старт

```ts
import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

const driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
const client = new CoordinationClient(driver)

// Создать узел координации один раз при подготовке окружения
await client.createNode('/local/my-app', {})

// Получить эксклюзивную блокировку
await using session = await client.createSession('/local/my-app', {})
await using lock = await session.mutex('job-lock').lock()

await doWork(lock.signal)
// lock.release()  ← вызывается автоматически
// session.close() ← вызывается автоматически
```

## Типы сессий

| Метод             | Когда использовать                                                       |
| ----------------- | ------------------------------------------------------------------------ |
| `createSession()` | Разовая операция: промис резолвится, когда сессия готова                 |
| `openSession()`   | Долгоживущая работа: автоматически пересоздаёт сессию после её истечения |
| `withSession()`   | Стиль с колбэком и гарантированной очисткой ресурсов                     |

`openSession()` — предпочтительный выбор для сервисов, работающих непрерывно.
Когда сервер инвалидирует сессию (например, из-за сетевой недоступности), `openSession()` автоматически
создаёт новую и повторно входит в тело цикла — никакой ручной логики переподключения не нужно.

```ts
const ctrl = new AbortController()

for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  ctrl.signal
)) {
  try {
    await doWork(session)
  } catch {
    if (session.signal.aborted) continue // сессия истекла — повтор
    throw error
  }

  break // выйти после одного успешного цикла
}
```

`session.signal` прерывается в момент истечения сессии на сервере, поэтому любая нижележащая
операция, принявшая этот сигнал, отменится автоматически.

## Мьютекс

Мьютекс обеспечивает эксклюзивный доступ между сессиями. Под капотом он захватывает все токены
эфемерного семафора — вызов `createSemaphore` не нужен.

### Блокирующий захват

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    await using lock = await session.mutex('job-lock').lock()

    await doWork(lock.signal)
    // lock.release() вызывается автоматически
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Неблокирующая попытка

`tryLock()` немедленно возвращает `null`, если мьютекс уже удерживается другой сессией.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)

const lock = await session.mutex('job-lock').tryLock()
if (!lock) {
  console.log('мьютекс занят — пропускаем')
  return
}

await using _ = lock
await doWork(lock.signal)
```

`lock.signal` прерывается при потере блокировки (например, при истечении сессии), поэтому
его можно передавать в нижележащие операции для их автоматической отмены.

## Семафор

Семафор управляет конкурентным доступом с настраиваемым количеством токенов.

### Создание и захват

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
const sem = session.semaphore('connections')

// Создать один раз (перехватить AlreadyExists, если семафор уже существует)
await sem.create({ limit: 10 })

// Захватить один токен — блокирует до появления свободного токена
await using lease = await sem.acquire({ count: 1 })
await doWork(lease.signal)
// lease.release() вызывается автоматически
```

### Эфемерный семафор

При `ephemeral: true` сервер создаёт семафор при первом захвате и удаляет его, когда
освобождается последний токен — предварительный вызов `create()` не нужен.

```ts
const utf8 = new TextEncoder()

await using lease = await sem.acquire({
  count: 1,
  ephemeral: true,
  data: utf8.encode('worker-a:8080'), // опциональные метаданные токена
})
```

### Неблокирующая попытка

```ts
const lease = await sem.tryAcquire({ count: 1 })
if (!lease) {
  console.log('семафор заполнен')
  return
}

await using _ = lease
await doWork(lease.signal)
```

### Наблюдение за изменениями

`watch()` немедленно отдаёт текущее состояние, а затем повторяет при каждом серверном
изменении. После перезапуска сессии первым всегда приходит актуальное состояние — никаких
устаревших данных, никаких пропущенных обновлений.

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    for await (const desc of session.semaphore('config').watch({ data: true })) {
      const config = JSON.parse(new TextDecoder().decode(desc.data))
      console.log('конфиг обновлён:', config)
    }
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Обновление данных семафора

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify({ version: 2 })))
```

## Выборы лидера

Выборы — это именованный семафор, где ровно одна сессия может удерживать единственный токен.
Владелец токена является лидером.

### Участие в выборах

`campaign()` блокирует выполнение, пока эта сессия не победит в выборах.

```ts
const utf8 = new TextEncoder()

for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    await using leadership = await session.election('primary').campaign(
      utf8.encode('worker-a:8080') // начальные данные лидера (например, адрес)
    )

    console.log('избран — начинаем работу лидера')

    // Обновить данные лидера без повторных выборов; все наблюдатели видят изменение немедленно.
    await leadership.proclaim(utf8.encode('worker-a:9090'))

    // leadership.signal прерывается при потере лидерства (истечение сессии, отставка).
    await doLeaderWork(leadership.signal)

    // leadership.resign() вызывается автоматически здесь
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Наблюдение за сменой лидера

`observe()` отдаёт значение при каждой смене лидера: избрание нового, обновление данных через
`proclaim()` или отставка. `state.signal` прерывается при смене лидера, что удобно для
ограничения работы рамками одного срока лидерства.

```ts
for await (const session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  signal
)) {
  try {
    for await (const state of session.election('primary').observe()) {
      if (!state.data.length) {
        console.log('лидер отсутствует')
        continue
      }

      const endpoint = new TextDecoder().decode(state.data)
      console.log(state.isMe ? 'я лидер:' : 'текущий лидер:', endpoint)
    }
  } catch {
    if (session.signal.aborted) continue
    throw error
  }

  break
}
```

### Разовый запрос текущего лидера

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
const leader = await session.election('primary').leader()
if (leader) {
  console.log('лидер:', new TextDecoder().decode(leader.data))
}
```

## Управление ресурсами через `await using`

Каждый ресурс реализует `Symbol.asyncDispose`, делая `await using` самым безопасным способом
управления временем жизни. Ресурсы освобождаются в обратном порядке объявления — гарантированно
даже при возникновении исключения.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork()
// _lease.release()  ← первым
// _lock.release()   ← вторым
// session.close()   ← последним
```

Без `await using` эквивалентный код требует вложенных блоков `try/finally` — по одному на каждый
ресурс. `await using` устраняет вложенность и делает забытую очистку невозможной.

## Управление узлами

```ts
const client = new CoordinationClient(driver)

// Создать узел координации (серверный контейнер для сессий и семафоров)
await client.createNode('/local/my-app', {})

// Получить текущую конфигурацию узла
const desc = await client.describeNode('/local/my-app')

// Обновить конфигурацию узла
await client.alterNode('/local/my-app', { selfCheckPeriod: 1000 })

// Удалить узел (завершится ошибкой, если есть активные сессии)
await client.dropNode('/local/my-app')
```

## Опции сессии

| Опция            | Тип           | По умолчанию | Описание                                                       |
| ---------------- | ------------- | ------------ | -------------------------------------------------------------- |
| `recoveryWindow` | `number` (мс) | `30_000`     | Сколько времени сервер сохраняет сессию при разрыве соединения |
| `description`    | `string`      | `''`         | Читаемая метка, видимая в диагностике сервера                  |
| `startTimeout`   | `number` (мс) | —            | Таймаут для начального установления сессии                     |
| `retryBackoff`   | `number` (мс) | —            | Базовая задержка между попытками переподключения               |

## Примеры {#examples}

### Мьютекс: эксклюзивная блокировка задачи {#examples-mutex}

```ts
// Два воркера конкурируют — в каждый момент работает только один.
async function runWorker(id: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using lock = await session.mutex('job').lock()
      console.log(`worker-${id}: блокировка получена`)
      await doWork(lock.signal)
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

await Promise.all([runWorker('a', ctrl.signal), runWorker('b', ctrl.signal)])
```

### Service discovery: эфемерная регистрация эндпоинтов {#examples-service-discovery}

```ts
const utf8 = new TextEncoder()
const text = new TextDecoder()

// Воркер: регистрируется, пока живёт сессия; автоматически снимается при её истечении.
async function register(endpoint: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using _lease = await session.semaphore('endpoints').acquire({
        count: 1,
        ephemeral: true,
        data: utf8.encode(endpoint),
      })
      await waitForAbort(session.signal)
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

// Наблюдатель: следит за актуальным списком эндпоинтов.
async function watch(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const desc of session.semaphore('endpoints').watch({ owners: true })) {
        const endpoints = (desc.owners ?? []).map((o) => text.decode(o.data))
        console.log('доступные воркеры:', endpoints)
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

### Общая конфигурация: распределение в реальном времени {#examples-shared-config}

```ts
// Публикатор: разовое обновление.
async function publish(config: object, signal: AbortSignal) {
  await using session = await client.createSession('/local/my-app', {}, signal)
  await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify(config)))
}

// Подписчик: получает текущее значение немедленно, затем каждое изменение.
async function subscribe(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const desc of session.semaphore('config').watch({ data: true })) {
        console.log('конфиг:', JSON.parse(new TextDecoder().decode(desc.data)))
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

### Выборы лидера с автоматическим переключением {#examples-election}

```ts
const utf8 = new TextEncoder()
const text = new TextDecoder()

// Кандидат: участвует в выборах и удерживает лидерство до истечения сессии.
async function runCandidate(name: string, signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      await using leadership = await session.election('primary').campaign(utf8.encode(name))
      console.log(`${name}: избран`)
      await waitForAbort(leadership.signal) // удерживать до потери
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}

// Наблюдатель: реагирует на смену лидера.
async function observe(signal: AbortSignal) {
  for await (const session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    try {
      for await (const state of session.election('primary').observe()) {
        const leader = state.data.length ? text.decode(state.data) : '(нет)'
        console.log('лидер:', leader, state.isMe ? '← я' : '')
      }
    } catch {
      if (session.signal.aborted) continue
      throw error
    }
    break
  }
}
```

## Дополнительные материалы

- [Узлы координации YDB](https://ydb.tech/docs/ru/reference/ydb-sdk/coordination)
- [Рецепт: выборы лидера](https://ydb.tech/docs/ru/recipes/ydb-sdk/leader-election)
- [Рецепт: service discovery](https://ydb.tech/docs/ru/recipes/ydb-sdk/service-discovery)
- [Рецепт: публикация конфигурации](https://ydb.tech/docs/ru/recipes/ydb-sdk/config-publication)
- [Запускаемые примеры](https://github.com/ydb-platform/ydb-js-sdk/tree/main/examples/coordination)
