# YDB Service Account Authentication Example

Этот пример демонстрирует подключение к YDB используя Yandex Cloud Service Account authorized key.

## Что демонстрирует

- **Авторизация через Service Account** - использование authorized key JSON файла
- **Создание credentials provider** из файла с помощью `ServiceAccountCredentialsProvider.fromFile()`
- **Автоматическое управление IAM токенами** - токены кешируются и обновляются автоматически
- **Выполнение простого запроса** для проверки подключения
- **Правильное управление ресурсами** (закрытие соединения)

## Требования

- Node.js >= 20.19
- Yandex Cloud Service Account authorized key файл (`authorized_key.json`)
- YDB база данных в Yandex Cloud

## Подготовка

1. **Создайте Service Account** в Yandex Cloud Console
2. **Создайте authorized key** для Service Account
3. **Сохраните ключ** в файл `authorized_key.json` в папке `examples/`

Формат файла `authorized_key.json`:

```json
{
  "id": "ajexxxxxxxxxxxxxxxxx",
  "service_account_id": "ajexxxxxxxxxxxxxxxxx",
  "created_at": "2023-01-01T00:00:00Z",
  "key_algorithm": "RSA_2048",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

## Запуск

```bash
# Установите зависимости
npm install

# Запустите пример
npm start
```

## Переменные окружения

- `YDB_CONNECTION_STRING` - строка подключения к YDB (обязательно для Yandex Cloud)
  - Формат: `grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/b1g.../etn...`

## Что происходит в примере

1. **Чтение authorized key** из файла `authorized_key.json`
2. **Создание credentials provider** с автоматическим управлением IAM токенами
3. **Подключение к YDB** с использованием Service Account авторизации
4. **Выполнение тестового запроса** `SELECT 1 as test_value`
5. **Закрытие соединения** для освобождения ресурсов

## Использование в вашем проекте

### Из файла

```javascript
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'
import { Driver } from '@ydbjs/core'

let provider = ServiceAccountCredentialsProvider.fromFile('./authorized_key.json')
let driver = new Driver(connectionString, {
  credentialsProvider: provider,
})
```

### Из объекта

```javascript
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'
import * as fs from 'node:fs'

let keyData = JSON.parse(fs.readFileSync('authorized_key.json', 'utf8'))
let provider = new ServiceAccountCredentialsProvider(keyData)
```

### Из переменной окружения

```javascript
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'

// Установите YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=/path/to/key.json
let provider = ServiceAccountCredentialsProvider.fromEnv()
```

## Как это работает

1. **JWT создание**: Provider создает JWT токен, подписанный PS256 алгоритмом используя приватный ключ
2. **IAM токен обмен**: JWT отправляется в Yandex Cloud IAM API для получения IAM токена
3. **Кеширование**: IAM токен кешируется и автоматически обновляется перед истечением (за 5 минут)
4. **YDB авторизация**: IAM токен используется как `x-ydb-auth-ticket` заголовок для YDB запросов

## Безопасность

- ⚠️ **Никогда не коммитьте** файлы `authorized_key.json` в git
- ✅ Используйте переменные окружения или secrets management в production
- ✅ Регулярно ротируйте ключи Service Account
- ✅ Предоставляйте минимально необходимые права Service Account

## Лучшие практики

### ✅ Правильное управление ресурсами

```javascript
try {
  await driver.ready()
  // работа с базой данных
} finally {
  driver.close() // всегда закрывайте соединение
}
```

### ✅ Использование переменных окружения

```bash
export YDB_CONNECTION_STRING="grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/..."
export YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS="/path/to/key.json"
```

### ✅ Обработка ошибок

```javascript
try {
  await driver.ready()
} catch (error) {
  if (error.issues) {
    // Обработка YDB ошибок
  }
  throw error
}
```

## Дополнительные возможности

Для более сложных сценариев изучите:

- **Кастомный IAM endpoint** через опции `ServiceAccountCredentialsProvider`
- **Принудительное обновление токена** через `getToken(true)`
- **Отмена операций** через `AbortSignal`
- **Retry стратегии** встроенные в provider

## Troubleshooting

### Ошибка "JWT signature validation fails"

- Проверьте, что приватный ключ корректный и не поврежден
- Убедитесь, что Service Account имеет необходимые права
- Проверьте формат файла `authorized_key.json`

### Ошибка подключения

- Проверьте `YDB_CONNECTION_STRING` - должен быть правильный формат
- Убедитесь, что база данных существует и доступна
- Проверьте сетевые настройки и firewall

### Ошибка чтения файла

- Убедитесь, что файл `authorized_key.json` существует и доступен для чтения
- Проверьте права доступа к файлу
- Убедитесь, что путь к файлу указан правильно
