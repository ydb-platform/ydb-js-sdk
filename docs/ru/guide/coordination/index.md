---
title: Coordination — Обзор
---

# Coordination (@ydbjs/coordination)

Примитивы распределённой координации для YDB: семафоры, мьютексы и выборы лидера на основе узлов координации YDB.

## Быстрый старт

```ts
import { Driver } from '@ydbjs/core'
import { CoordinationClient } from '@ydbjs/coordination'

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
let client = new CoordinationClient(driver)

// Создать узел координации один раз при подготовке окружения
await client.createNode('/local/my-app', {})

// Получить эксклюзивную блокировку
await using session = await client.createSession('/local/my-app', {})
await using lock = await session.mutex('job-lock').lock()

await doWork(AbortSignal.any([session.signal, lock.signal]))
// lock.release()  ← вызывается автоматически
// session.close() ← вызывается автоматически
```

## Типы сессий

| Метод             | Когда использовать                                                       |
| ----------------- | ------------------------------------------------------------------------ |
| `createSession()` | Разовая операция: промис резолвится, когда сессия готова                 |
| `openSession()`   | Долгоживущая работа: автоматически пересоздаёт сессию после её истечения |
| `withSession()`   | Стиль с колбэком и гарантированной очисткой ресурсов                     |

Сессией, полученной из `openSession()`, управляет вызывающий код. Объявите `await using activeSession = session` в теле цикла, чтобы закрывать её при `break`, возврате и исключениях. Следующая сессия создаётся только после завершения тела цикла и истечения предыдущей; итератор сам не прерывает работу приложения.

`openSession()` — предпочтительный выбор для сервисов, работающих непрерывно.
Когда сервер инвалидирует сессию (например, из-за сетевой недоступности), `openSession()` автоматически
создаёт новую и повторно входит в тело цикла — никакой ручной логики переподключения не нужно.

```ts
let ctrl = new AbortController()

for await (let session of client.openSession(
  '/local/my-app',
  { recoveryWindow: 15_000 },
  ctrl.signal
)) {
  await using activeSession = session

  try {
    await doWork(activeSession.signal)
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break // выйти после одного успешного цикла
}
```

`session.signal` прерывается, когда клиент обнаруживает истечение сессии или закрывает её. Он не сообщает точный момент потери сессии на сервере. Передавайте этот сигнал работе, которая должна остановиться вместе с локальной сессией.

## Мьютекс

Мьютекс обеспечивает эксклюзивный доступ между сессиями. Под капотом он захватывает все токены
эфемерного семафора — вызов `createSemaphore` не нужен.

### Блокирующий захват

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    await using lock = await activeSession.mutex('job-lock').lock()

    await doWork(AbortSignal.any([activeSession.signal, lock.signal]))
    // lock.release() вызывается автоматически
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break
}
```

### Неблокирующая попытка

`tryLock()` немедленно возвращает `null`, если мьютекс уже удерживается другой сессией.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)

let lock = await session.mutex('job-lock').tryLock()
if (lock) {
  await using _ = lock
  await doWork(AbortSignal.any([session.signal, lock.signal]))
} else {
  console.log('мьютекс занят — пропускаем')
}
```

`lock.signal` прерывается после успеха или ошибки локального освобождения; ошибка становится его reason. Этот сигнал не доказывает, что сервер освободил блокировку. Завершение сессии отслеживайте через `session.signal`.

## Семафор

Семафор управляет конкурентным доступом с настраиваемым количеством токенов.

### Создание и захват

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
let sem = session.semaphore('connections')

// Создать один раз (перехватить AlreadyExists, если семафор уже существует)
await sem.create({ limit: 10 })

// Захватить один токен — блокирует до появления свободного токена
await using lease = await sem.acquire({ count: 1 })
await doWork(AbortSignal.any([session.signal, lease.signal]))
// lease.release() вызывается автоматически
```

### Эфемерный семафор

При `ephemeral: true` сервер создаёт семафор при первом захвате и удаляет его, когда
освобождается последний токен — предварительный вызов `create()` не нужен.

```ts
let utf8 = new TextEncoder()

await using lease = await sem.acquire({
  count: 1,
  ephemeral: true,
  data: utf8.encode('worker-a:8080'), // опциональные метаданные токена
})
```

### Неблокирующая попытка

```ts
let lease = await sem.tryAcquire({ count: 1 })
if (lease) {
  await using _ = lease
  await doWork(AbortSignal.any([session.signal, lease.signal]))
} else {
  console.log('семафор заполнен')
}
```

### Наблюдение за изменениями

`watch()` отдаёт текущее состояние и следит за выбранными полями. Несколько изменений могут объединяться в одно уведомление: это подписка на состояние, а не журнал событий. После истечения сессии начните новое наблюдение на следующей сессии из `openSession()`.

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    for await (let desc of activeSession.semaphore('config').watch({ data: true })) {
      let config = JSON.parse(new TextDecoder().decode(desc.data))
      console.log('конфиг обновлён:', config)
    }
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

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

Создайте семафор выборов один раз при подготовке приложения, до запуска кандидатов. `campaign()` не создаёт его. Повторный вызов для существующего семафора возвращает `ALREADY_EXISTS`.

```ts
{
  await using setup = await client.createSession('/local/my-app', {})
  await setup.semaphore('primary').create({ limit: 1 })
}
```

### Участие в выборах

`campaign()` блокирует выполнение, пока эта сессия не победит в выборах.

```ts
let utf8 = new TextEncoder()

for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    await using leadership = await activeSession.election('primary').campaign(
      utf8.encode('worker-a:8080') // начальные данные лидера (например, адрес)
    )

    console.log('избран — начинаем работу лидера')

    await doLeaderWork(AbortSignal.any([activeSession.signal, leadership.signal]))

    // leadership.resign() вызывается автоматически здесь
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break
}
```

`leadership.signal` отражает локальное освобождение захвата и сам по себе не прерывается при истечении сессии. Для работы лидера объединяйте его с `session.signal`. `proclaim(data)` обновляет данные самого семафора, а `leader()` и `observe()` возвращают данные владельца, переданные в `campaign()`. Изменения данных семафора отслеживайте через `semaphore.watch({ data: true })`.

### Наблюдение за сменой лидера

`observe()` выдаёт изменения владельца (`sessionId` и порядок захвата), а после ухода лидера — отсутствие владельца. `state.signal` прерывается, когда итератор замечает смену владельца или завершается. Для получения изменений нужно продолжать чтение итератора; время жизни сессии отслеживайте также через `session.signal`.

```ts
for await (let session of client.openSession('/local/my-app', { recoveryWindow: 15_000 }, signal)) {
  await using activeSession = session

  try {
    for await (let state of activeSession.election('primary').observe()) {
      if (!state.data.length) {
        console.log('лидер отсутствует')
        continue
      }

      let endpoint = new TextDecoder().decode(state.data)
      console.log(state.isMe ? 'я лидер:' : 'текущий лидер:', endpoint)
    }
  } catch (error) {
    if (activeSession.signal.aborted) {
      continue
    }

    throw error
  }

  break
}
```

### Разовый запрос текущего лидера

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
let leader = await session.election('primary').leader()
if (leader) {
  console.log('лидер:', new TextDecoder().decode(leader.data))
}
```

## Управление ресурсами через `await using`

Каждый ресурс реализует `Symbol.asyncDispose`, делая `await using` самым безопасным способом
управления временем жизни. Ресурсы освобождаются в обратном порядке объявления — гарантированно
даже при возникновении исключения.

Перед запуском примера создайте постоянный семафор `quota` с положительным лимитом; получение lease не создаёт семафор.

```ts
await using session = await client.createSession('/local/my-app', {}, signal)
await using _lock = await session.mutex('job').lock()
await using _lease = await session.semaphore('quota').acquire({ count: 1 })

await doWork(session.signal)
// _lease.release()  ← первым
// _lock.release()   ← вторым
// session.close()   ← последним
```

Без `await using` эквивалентный код требует вложенных блоков `try/finally` — по одному на каждый
ресурс. `await using` устраняет вложенность и делает забытую очистку невозможной.

## Управление узлами

```ts
let client = new CoordinationClient(driver)

// Создать узел координации (серверный контейнер для сессий и семафоров)
await client.createNode('/local/my-app', {})

// Получить текущую конфигурацию узла
let desc = await client.describeNode('/local/my-app')

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
| `startTimeout`   | `number` (мс) | `3_000`      | Таймаут для начального установления сессии                     |
| `retryBackoff`   | `number` (мс) | `30`         | Базовая задержка между попытками переподключения               |

## Примеры {#examples}

`doWork(signal)`, `doLeaderWork(signal)` и `waitForAbort(signal)` в примерах обозначают функции приложения. Они должны завершаться ошибкой при отмене сигнала, в том числе если сигнал уже был отменён до вызова.

### Мьютекс: эксклюзивная блокировка задачи {#examples-mutex}

```ts
// Два воркера конкурируют — в каждый момент работает только один.
async function runWorker(id: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using lock = await activeSession.mutex('job').lock()
      console.log(`worker-${id}: блокировка получена`)
      await doWork(AbortSignal.any([activeSession.signal, lock.signal]))
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

await Promise.all([runWorker('a', ctrl.signal), runWorker('b', ctrl.signal)])
```

### Service discovery: эфемерная регистрация эндпоинтов {#examples-service-discovery}

```ts
let utf8 = new TextEncoder()
let text = new TextDecoder()

// Воркер: регистрируется, пока живёт сессия; автоматически снимается при её истечении.
async function register(endpoint: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using _lease = await activeSession.semaphore('endpoints').acquire({
        count: 1,
        ephemeral: true,
        data: utf8.encode(endpoint),
      })
      await waitForAbort(activeSession.signal)
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

// Наблюдатель: следит за актуальным списком эндпоинтов.
async function watch(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let desc of activeSession.semaphore('endpoints').watch({ owners: true })) {
        let endpoints = (desc.owners ?? []).map((owner) => {
          return text.decode(owner.data)
        })
        console.log('доступные воркеры:', endpoints)
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}
```

### Общая конфигурация: распределение в реальном времени {#examples-shared-config}

До запуска этих функций создайте постоянный семафор `config` с `limit: 1` и начальными JSON-данными, например `new TextEncoder().encode('{}')`. Методы `update()` и `watch()` не создают семафор.

```ts
// Публикатор: разовое обновление.
async function publish(config: object, signal: AbortSignal) {
  await using session = await client.createSession('/local/my-app', {}, signal)
  await session.semaphore('config').update(new TextEncoder().encode(JSON.stringify(config)))
}

// Подписчик: получает текущее значение немедленно, затем каждое изменение.
async function subscribe(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let desc of activeSession.semaphore('config').watch({ data: true })) {
        console.log('конфиг:', JSON.parse(new TextDecoder().decode(desc.data)))
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}
```

### Выборы лидера с автоматическим переключением {#examples-election}

```ts
let utf8 = new TextEncoder()
let text = new TextDecoder()

// Кандидат: участвует в выборах и удерживает лидерство до истечения сессии.
async function runCandidate(name: string, signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      await using leadership = await activeSession.election('primary').campaign(utf8.encode(name))
      console.log(`${name}: избран`)
      await waitForAbort(AbortSignal.any([activeSession.signal, leadership.signal]))
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

      throw error
    }
    break
  }
}

// Наблюдатель: реагирует на смену лидера.
async function observe(signal: AbortSignal) {
  for await (let session of client.openSession(
    '/local/my-app',
    { recoveryWindow: 15_000 },
    signal
  )) {
    await using activeSession = session

    try {
      for await (let state of activeSession.election('primary').observe()) {
        let leader = state.data.length ? text.decode(state.data) : '(нет)'
        console.log('лидер:', leader, state.isMe ? '← я' : '')
      }
    } catch (error) {
      if (activeSession.signal.aborted) {
        continue
      }

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
