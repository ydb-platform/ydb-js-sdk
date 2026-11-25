# YDB Serverless Example

Этот пример демонстрирует использование YDB JavaScript SDK в serverless окружениях, таких как AWS Lambda, Yandex Cloud Functions, Vercel Functions, или других FaaS платформах.

## Что демонстрирует

- Правильное создание драйвера внутри handler функции
- Решение проблем с HTTP/2 соединениями в serverless
- Корректное управление жизненным циклом соединений
- Работа с переменными окружения в serverless

## Запуск

```bash
# Установите зависимости
npm install

# Запустите пример локально
npm start

# Запустите с отладочной информацией
npm run dev
```

## Переменные окружения

- `YDB_CONNECTION_STRING` - строка подключения к YDB (например, `grpc://localhost:2136/local`)

## Особенности serverless

### Время жизни Driver и Query

Пример создаёт Driver внутри обработчика и закрывает его при завершении вызова. Если приложение использует пул запросов, закройте его до Driver:

```javascript
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

export async function handler(event) {
  let driver = new Driver(process.env.YDB_CONNECTION_STRING)

  try {
    let sql = query(driver)
    try {
      let resultSets = await sql`SELECT 1 + 1 AS sum`
      return { statusCode: 200, body: { resultSets } }
    } finally {
      await sql.close()
    }
  } finally {
    driver.close()
  }
}
```

`await sql.close()` дожидается закрытия пула запросов; затем `driver.close()` синхронно закрывает соединения. Пример запускается как JavaScript без транспиляции, поэтому использует `try/finally`, совместимый с поддерживаемой веткой Node.js 22. Закрытие Driver само по себе не заменяет закрытие пула.

Возможность сохранять Driver между вызовами зависит от жизненного цикла процесса и ограничений платформы. SDK не устанавливает общего запрета на повторное использование Driver; для такого режима нужна проверка поведения после заморозки и возобновления процесса в выбранной среде.

## Использование

Скопируйте эту папку в свой serverless проект:

```bash
cp -r examples/sls my-serverless-ydb-project
cd my-serverless-ydb-project
npm install
```

## Развертывание

### Yandex Cloud Functions

1. Создайте функцию в [Yandex Cloud Console](https://console.cloud.yandex.ru/)
2. Выберите среду выполнения с Node.js `^22.23.5 || ^24.22.3 || >=26.13.1` и проверьте фактическую patch-версию платформы
3. Загрузите код или подключите Git репозиторий
4. Настройте переменные окружения:
   - `YDB_CONNECTION_STRING` - строка подключения к YDB (например, `grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1xxxxxxxxxxxxxxxxx/etnxxxxxxxxxxxxxxxx`)
5. Установите точку входа как `index.handler`

### Другие платформы

Адаптируйте код под API вашей serverless платформы.
