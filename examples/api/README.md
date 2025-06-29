# YDB API Example

Простой пример работы с низкоуровневым gRPC API YDB JavaScript SDK.

## Что демонстрирует

### 🔌 **Подключение и аутентификация**
- Создание драйвера с настройками подключения
- Использование StaticCredentialsProvider для аутентификации

### 📡 **Discovery Service**
- `listEndpoints()` - получение списка доступных endpoint'ов
- `whoAmI()` - информация о текущем пользователе

### � **Scheme Service**
- `listDirectory()` - просмотр структуры базы данных
- Сортировка и отображение объектов с пометкой системных таблиц 🔧

## Запуск

```bash
# Запустите пример
npm start

# Или напрямую через node
node index.js

# С отладочной информацией
DEBUG=ydbjs:* node index.js
```

## Переменные окружения

- `YDB_CONNECTION_STRING` - строка подключения к YDB (по умолчанию: `grpc://localhost:2136/local`)

## Пример вывода

```
🔗 Подключение к YDB: grpc://localhost:2136/local
✅ Подключение установлено

📡 Доступные endpoint'ы:
   Всего: 1
   1. localhost:2136

🆔 Информация о пользователе:
   Пользователь: root
   Группы: нет

📁 Содержимое базы данных:
   Путь: /local
   Владелец: root
   Объектов: 3
   1. .sys (тип: 1) 🔧
   2. .sys_health (тип: 1) 🔧
   3. test_table (тип: 2)

✅ Готово!
```

## Структура кода

```javascript
// Создание драйвера с аутентификацией
let driver = new Driver(connectionString, {
    credentialsProvider: new StaticCredentialsProvider(
        { username: 'root', password: '1234' },
        connectionStringForAuth
    )
})

// Создание клиента для сервиса
let discovery = driver.createClient(DiscoveryServiceDefinition)

// Вызов метода API
let response = await discovery.listEndpoints({ database: driver.database })

// Распаковка результата
let endpoints = anyUnpack(response.operation?.result, ListEndpointsResultSchema)
```

## Особенности

- **Happy Path подход** - код фокусируется на успешном сценарии
- **Минимум проверок** - убраны избыточные try/catch и assert
- **Читаемый вывод** - структурированная информация с эмодзи
- **Сортировка объектов** - алфавитный порядок для лучшей читаемости

## Использование

Скопируйте этот пример в свой проект:

```bash
cp -r examples/api my-ydb-project
cd my-ydb-project
npm install
npm start
```

## Полезные ссылки

- [YDB JavaScript SDK](https://github.com/ydb-platform/ydb-js-sdk)
- [YDB Documentation](https://ydb.tech/docs/)
- [gRPC API Reference](https://ydb.tech/docs/reference/ydb-sdk/)
- [Protocol Buffers](https://protobuf.dev/)
