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

using driver = new Driver(process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local')
await driver.ready()

// Use the driver with Query/Topic or low-level clients
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
    {
      username: process.env.YDB_USER!,
      password: process.env.YDB_PASSWORD!,
    },
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

### 5) Автоопределение из переменных окружения

`EnvironCredentialsProvider` читает переменные окружения и автоматически выбирает нужный метод аутентификации. Также определяет TLS-конфигурацию.

```ts
import { Driver } from '@ydbjs/core'
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ'

let cs = process.env['YDB_CONNECTION_STRING']!
let creds = new EnvironCredentialsProvider(cs)

const driver = new Driver(cs, {
  credentialsProvider: creds,
  secureOptions: creds.secureOptions,
})
await driver.ready()
```

Приоритет определения (первое совпадение):

| Переменная                          | Описание                                                      |
| ----------------------------------- | ------------------------------------------------------------- |
| `YDB_ANONYMOUS_CREDENTIALS=1`       | Anonymous                                                     |
| `YDB_METADATA_CREDENTIALS=1`        | Cloud metadata                                                |
| `YDB_METADATA_CREDENTIALS_ENDPOINT` | Кастомный endpoint метадаты (по умолчанию: GCE metadata)      |
| `YDB_METADATA_CREDENTIALS_FLAVOR`   | Кастомный flavor метадаты (по умолчанию: `Google`)            |
| `YDB_ACCESS_TOKEN_CREDENTIALS`      | Access token                                                  |
| `YDB_STATIC_CREDENTIALS_USER`       | Имя пользователя для static auth                              |
| `YDB_STATIC_CREDENTIALS_PASSWORD`   | Пароль (по умолчанию: пустая строка)                          |
| `YDB_STATIC_CREDENTIALS_ENDPOINT`   | Endpoint аутентификации (по умолчанию: из строки подключения) |

TLS настраивается через `YDB_SSL_ROOT_CERTIFICATES_FILE` (или `YDB_SSL_ROOT_CERTIFICATES` для PEM-строки), `YDB_SSL_CERTIFICATE_FILE` / `YDB_SSL_CERTIFICATE`, `YDB_SSL_PRIVATE_KEY_FILE` / `YDB_SSL_PRIVATE_KEY`.

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

Реализуйте `CredentialsProvider.getToken(force?, signal?)`. Driver получает токен и перед отправкой RPC добавляет `x-ydb-auth-ticket`, заголовки базы данных и SDK. Провайдер управляет кешем и обновлением токена; middleware для него не требуется.

Одно обновление должно обслуживать несколько одновременных вызовов. В примере `fetchTokenSomehow(signal)` запрашивает токен и возвращает `{ value, expiresAt }`, где `expiresAt` — время истечения токена в миллисекундах Unix. Передайте сигнал провайдера в этот сетевой запрос.

```ts
import { abortable } from '@ydbjs/abortable'
import { CredentialsProvider } from '@ydbjs/auth'
import { Driver } from '@ydbjs/core'

class MyCredentialsProvider extends CredentialsProvider {
  #token: { value: string; expiresAt: number } | undefined
  #refreshPromise: Promise<string> | undefined

  async getToken(force = false, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (!force && this.#token && this.#token.expiresAt > Date.now()) {
      return this.#token.value
    }

    if (!this.#refreshPromise) {
      let timeout = AbortSignal.timeout(5000)
      this.#refreshPromise = fetchTokenSomehow(timeout)
        .then((token) => {
          this.#token = token
          return token.value
        })
        .finally(() => {
          this.#refreshPromise = undefined
        })
    }

    return signal ? abortable(signal, this.#refreshPromise) : this.#refreshPromise
  }
}

using driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
  credentialsProvider: new MyCredentialsProvider(),
})
await driver.ready()
```

Таймаут создаётся только при запуске нового запроса токена. Чтение из кеша и присоединение к уже запущенному обновлению не создают дополнительных таймаутов провайдера. После успеха или ошибки `#refreshPromise` очищается, поэтому следующий вызов сможет повторить попытку. Для короткоживущих токенов можно также начинать обновление заранее, продолжая возвращать действующий токен.

### Deadline RPC и отмена ожидания

Driver вызывает `getToken()` без сигнала RPC. Он ограничивает собственное ожидание настройкой `ydb.sdk.token_timeout_ms` (по умолчанию 10000 мс), общим deadline вызова и отменой вызывающего кода. Таймаут ожидания токена возвращает `Status.DEADLINE_EXCEEDED`; отмена сохраняет исходную причину. Один абсолютный deadline покрывает авторизацию и сам RPC и не перезапускается после получения токена.

При прямом вызове `provider.getToken(false, signal)` функция `abortable` отменяет только ожидание этого вызывающего кода. Запрос токена продолжает работать с собственным таймаутом провайдера, может заполнить кеш и вернуть результат остальным ожидающим. Поэтому отмена одного RPC или закрытие его Driver не прерывает обновление, нужное другому запросу.

## Низкоуровневые сервис‑клиенты

```ts
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

let discovery = driver.createClient(DiscoveryServiceDefinition)
let response = await discovery.listEndpoints({ database: driver.database })
console.log(response)
```

См. также «Расширенные темы → Низкоуровневые клиенты (driver)».
