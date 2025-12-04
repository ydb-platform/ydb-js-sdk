---
title: Начало работы
---

# Начало работы с YDB JS SDK

Этот раздел поможет быстро подключиться к YDB из JavaScript/TypeScript и выполнить первые запросы. В примерах используется пакет `@ydbjs/core`.

## Строка подключения

- Формат: `grpc://host:port/database` или `grpcs://host:port/database` (TLS)
- Пример: `grpcs://ydb.example.com:2135/ru-central1/b1.../etn...`

## Быстрый старт

```ts
import { Driver } from '@ydbjs/core'

const driver = new Driver(
  process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local'
)
await driver.ready()

// используйте driver для Query/Topic или низкоуровневых клиентов

await driver.close()
```

## Провайдеры аутентификации (`@ydbjs/auth`)

Поддерживаются несколько стратегий. Укажите `credentialsProvider` в опциях драйвера.

### 1) Access Token

```ts
import { Driver } from '@ydbjs/core'
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new AccessTokenCredentialsProvider({
    token: process.env.YDB_TOKEN!,
  }),
})
await driver.ready()
```

### 2) Static Credentials (username/password)

```ts
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'

const authEndpoint = 'grpcs://ydb.example.com:2135' // AuthService endpoint
const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new StaticCredentialsProvider(
    { username: process.env.YDB_USER!, password: process.env.YDB_PASSWORD! },
    authEndpoint
  ),
})
await driver.ready()
```

### 3) Metadata (облако)

```ts
import { Driver } from '@ydbjs/core'
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'

const driver = new Driver(process.env.YDB_CONNECTION_STRING!, {
  credentialsProvider: new MetadataCredentialsProvider({
    // endpoint?: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'
  }),
})
await driver.ready()
```

### 4) Anonymous (для локалки/публичных БД)

```ts
import { Driver } from '@ydbjs/core'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'

const driver = new Driver('grpc://localhost:2136/local', {
  credentialsProvider: new AnonymousCredentialsProvider(),
})
await driver.ready()
```

## TLS и mTLS в Driver

Передайте `secureOptions` (Node.js `tls.SecureContextOptions`). Если строка подключения `grpcs://...`, по умолчанию используется системное хранилище CA; `secureOptions` позволяет указать свои корни/сертификаты.

### TLS с кастомным CA

```ts
import { Driver } from '@ydbjs/core'
import * as fs from 'node:fs'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  secureOptions: {
    ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
    servername: 'ydb.example.com', // SNI, если нужно
  },
})
await driver.ready()
```

### mTLS (client cert + key)

```ts
import { Driver } from '@ydbjs/core'
import * as fs from 'node:fs'

const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  secureOptions: {
    ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
    cert: fs.readFileSync('/etc/ssl/custom/client.crt'),
    key: fs.readFileSync('/etc/ssl/custom/client.key'),
    // passphrase?: '...',
  },
})
await driver.ready()
```

## TLS/mTLS для StaticCredentialsProvider

Static‑провайдер проходит аутентификацию в AuthService по gRPC. Ему можно отдельно передать `secureOptions` для канала аутентификации:

```ts
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import * as fs from 'node:fs'

const authEndpoint = 'grpcs://ydb.example.com:2135'
const driver = new Driver('grpcs://ydb.example.com:2135/your-db', {
  credentialsProvider: new StaticCredentialsProvider(
    {
      username: 'user',
      password: 'pass',
    },
    authEndpoint,
    {
      ca: fs.readFileSync('/etc/ssl/custom/ca.pem'),
      cert: fs.readFileSync('/etc/ssl/custom/client.crt'), // при mTLS
      key: fs.readFileSync('/etc/ssl/custom/client.key'), // при mTLS
    }
  ),
})
await driver.ready()
```

## Создание своего провайдера

Реализуйте `CredentialsProvider` и метод `getToken(force?, signal?)`. Мидлварь провайдера автоматически проставит заголовок `x-ydb-auth-ticket` для всех вызовов.

```ts
import { CredentialsProvider } from '@ydbjs/auth'

class MyCredentialsProvider extends CredentialsProvider {
  #token: string | null = null
  async getToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!force && this.#token) return this.#token
    const token = await fetchTokenSomehow(signal)
    this.#token = token
    return token
  }
}

const driver = new Driver(process.env.YDB_CONNECTION_STRING!, {
  credentialsProvider: new MyCredentialsProvider(),
})
```

Советы:

- Кешируйте токен и продлевайте его заранее (как делает `StaticCredentialsProvider`).
- Учтите таймауты: `ydb.sdk.token_timeout_ms` в опциях драйвера.

### Почему важен AbortSignal и как правильно реагировать на abort

- Driver передаёт в `getToken()` `signal` с таймаутом (`ydb.sdk.token_timeout_ms`). Это гарантирует, что получение токена не «зависнет» и общий вызов к YDB не превысит SLA.
- Ваш провайдер обязан:
  - передавать этот `signal` во все сетевые вызовы (fetch/gRPC/HTTP);
  - при `signal.aborted` как можно быстрее завершаться и пробрасывать отмену (обычно ошибка с именем `AbortError`).
- Это важно для корректных ретраев и быстрой деградации: драйвер сможет повторить попытку или корректно завершить операцию.

Пример корректной обработки:

```ts
class MyCredentialsProvider extends CredentialsProvider {
  #token: string | null = null

  async getToken(
    force = false,
    signal: AbortSignal = AbortSignal.timeout(10_000)
  ) {
    if (!force && this.#token) return this.#token
    const abort = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const res = await fetch(this.#endpoint, {
      method: 'POST',
      body: '{}',
      signal: abort,
    })
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
    const { token } = await res.json()
    this.#token = token
    return token
  }
}
```

## Низкоуровневые сервис‑клиенты

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

const discovery = driver.createClient(DiscoveryServiceDefinition)
const endpoints = await discovery.listEndpoints({ database: driver.database })
```

См. также «Расширенные темы → Низкоуровневые клиенты (driver)».
