# YDB Topic Examples

Два сценария:

- Базовый reader/writer
- Чтение и запись в одной транзакции

## Запуск

```bash
cd examples/topic
npm install
export YDB_CONNECTION_STRING=grpc://localhost:2136/local
npm test
```

`npm test` создаёт временный топик с консьюмером `demo-consumer`, запускает пример и удаляет топик после проверки.
Чтобы запустить `npm start` со своим топиком, укажите его путь в `YDB_TOPIC` и заранее создайте в нём консьюмер `demo-consumer`. По умолчанию пример использует топик `demo-topic` в базе из строки подключения.
