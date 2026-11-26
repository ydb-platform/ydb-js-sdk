# YDB Query Example

Этот пример демонстрирует выполнение SQL‑запросов с помощью YDB JavaScript SDK.

## Что демонстрирует

- **Создание таблиц** с различными типами данных (Uint64, Text, Timestamp, Json)
- **Параметризованные запросы** с безопасной передачей параметров
- **Работа с массивами данных** через AS_TABLE()
- **JSON‑операции** для работы с метаданными
- **Правильное управление ресурсами** (закрытие соединения)
- **Обработка ошибок** с try/catch

## Запуск

Поддерживаемые версии Node.js: `^22.23.5 || ^24.22.3 || >=26.13.1`.
Используйте отдельную базу для примера: он удаляет существующие строки из `test_table`.

```bash
# Установите зависимости
npm install

# Запустите пример
npm start

# Запустите с отладочной информацией
npm run dev
```

## Переменные окружения

- `YDB_CONNECTION_STRING` - строка подключения к YDB (по умолчанию: `grpc://localhost:2136/local`)

## Что происходит в примере

1. **Подключение к YDB** и ожидание готовности
2. **Создание таблицы** `test_table` с колонками разных типов
3. **Вставка тестовых данных** с использованием AS_TABLE()
4. **Поиск записи по ID** с параметризованным запросом
5. **Подсчёт общего количества** записей
6. **JSON-запрос** для поиска записей по тегам в метаданных
7. **Закрытие соединения** для освобождения ресурсов

## Лучшие практики из примера

### ✅ Правильное управление ресурсами

```javascript
try {
  await driver.ready()
  await sql`SELECT 1`
} finally {
  try {
    await sql.close()
  } finally {
    driver.close()
  }
}
```

### ✅ Параметризованные запросы

```javascript
import { Uint64 } from '@ydbjs/value/primitive'

let searchId = new Uint64(2n)
let [rows] = await sql`SELECT * FROM test_table WHERE id = ${searchId}`
```

### ✅ Работа с JSON в YDB

```javascript
await sql`
  SELECT id, title FROM test_table
  WHERE JSON_EXISTS(metadata, "$.tags[*]")
`
```

### ✅ Массовая вставка данных

```javascript
import { Uint64 } from '@ydbjs/value/primitive'

let data = [
  { id: new Uint64(4n), title: 'First' },
  { id: new Uint64(5n), title: 'Second' },
]

await sql`UPSERT INTO test_table (id, title) SELECT id, title FROM AS_TABLE(${data})`
```

## Рекомендации

- **Используйте TypeScript** для лучшей типизации результатов
- **Обрабатывайте ошибки** с помощью try/catch
- **Закрывайте клиент перед драйвером** в блоке finally
- **Используйте параметры** вместо конкатенации строк
- **Изучите YDB типы** в пакете `@ydbjs/value`

## Использование

Скопируйте эту папку в свой проект и адаптируйте код под ваши потребности:

```bash
cp -r examples/query my-ydb-query-project
cd my-ydb-query-project
npm install
npm start
```

## Дополнительные возможности

Для более сложных сценариев изучите:

- **Транзакции** с `sql.begin()` или `sql.transaction()`
- **Статистику запросов** с `.withStats()`
- **Различные уровни изоляции** транзакций
- **Потоковое чтение** через `session.stream()` внутри `QueryClient.retrySession()`
