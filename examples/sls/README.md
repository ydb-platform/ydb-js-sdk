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

### ⚠️ ВАЖНО: Создание драйвера в handler

**YDB SDK использует HTTP/2 соединения, которые могут вызвать непредсказуемые проблемы при переиспользовании между вызовами функции в serverless окружениях!**

```javascript
// ❌ НЕПРАВИЛЬНО - НЕ ДЕЛАЙТЕ ТАК!
let driver = new Driver(connectionString) // вне handler

export async function handler(event) {
  // использование driver - могут возникнуть странные ошибки!
}

// ✅ ПРАВИЛЬНО - создавайте драйвер внутри handler
export async function handler(event) {
  let driver = new Driver(connectionString)
  try {
    // используйте driver
  } finally {
    driver.close() // освобождает gRPC ресурсы и закрывает event loop handles
  }
}
```

### Проблемы с HTTP/2 в serverless

В serverless окружениях (AWS Lambda, Yandex Cloud Functions, etc.) HTTP/2 соединения, переиспользуемые между вызовами функции, могут вызывать непредсказуемые проблемы: внезапные timeout'ы, зависающие запросы, intermittent ошибки соединения. Эти проблемы сложно диагностировать и воспроизвести.

### Рекомендации

1. **Всегда создавайте новый Driver внутри handler функции**
2. **Обязательно вызывайте `driver.close()` в конце работы** - освобождает gRPC ресурсы и закрывает event loop handles
3. **Не пытайтесь кэшировать Driver между вызовами**
4. **SDK оптимизирован для быстрого создания соединений**

### Почему важно закрывать драйвер

Если не закрывать драйвер, то:

- Остаются активные gRPC соединения и event loop handles
- Возможны memory leaks в Node.js runtime
- В serverless окружениях функция может "зависнуть" и не завершиться корректно
- Накопление незакрытых ресурсов между вызовами

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
2. Выберите среду выполнения Node.js 22
3. Загрузите код или подключите Git репозиторий
4. Настройте переменные окружения:
   - `YDB_CONNECTION_STRING` - строка подключения к YDB (например, `grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1xxxxxxxxxxxxxxxxx/etnxxxxxxxxxxxxxxxx`)
5. Установите точку входа как `index.handler`

### Другие платформы

Адаптируйте код под API вашей serverless платформы.
