---
title: Topic — опции
---

# Опции и методы Topic Reader/Writer

## Reader

- `topic`: `string | TopicReaderSource | TopicReaderSource[]`
  - `TopicReaderSource`: `{ path: string; partitionIds?: bigint[]; maxLag?: number | string | Duration; readFrom?: Date | Timestamp }`
- `consumer`: `string`
- `codecMap?`: `Map<Codec | number, CompressionCodec>` — дополнительные кодеки распаковки
- `maxBufferBytes?`: `bigint` — лимит внутреннего буфера (по умолчанию ~4 МБ)
- `updateTokenIntervalMs?`: `number` — период обновления токена (по умолчанию 60000)
- `onPartitionSessionStart?`: `(session, committedOffset, { start, end }) => Promise<void | { readOffset?, commitOffset? }>`
- `onPartitionSessionStop?`: `(session, committedOffset) => Promise<void>`
- `onCommittedOffset?`: `(session, committedOffset) => void`

Методы и поведение:
- `read({ limit?, waitMs?, signal? })`: `AsyncIterable<TopicMessage[]>`
  - Возвращает последовательность батчей сообщений. `limit` ограничивает общее число сообщений, извлекаемых за один «пробег» итератора, чтобы контролировать задержку и память. `waitMs` задаёт максимальное ожидание поступления данных; по таймауту итератор вернёт пустой батч `[]`, что позволяет неблокирующую интеграцию в event loop. `signal` позволяет прервать ожидание/чтение.
  - Почему так: длительные блокировки чтения мешают кооперативной многозадачности; «пустые» отдачи по таймауту упрощают планирование работы без busy‑wait.
- `commit(messages | message)`: `Promise<void>`
  - Подтверждает обработку до соответствующего оффсета в каждой затронутой партиции (идемпотентно). Коммит гарантирует, что последующее чтение начнётся после подтверждённого оффсета. Можно вызывать на массиве сообщений (одного батча) или одном сообщении.
  - Зачем: это реализация как минимум один раз (at‑least‑once). Коммит отделяет «прочитано» от «обработано» и позволяет безопасное восстановление.
  - Перфоманс: ожидание `await commit()` в горячем пути снижает пропускную способность. Допустима стратегия fire‑and‑forget (`void reader.commit(batch)`) c наблюдением через `onCommittedOffset`.
- `close()`: `Promise<void>`
  - Завершает чтение «мягко»: перестаёт принимать новые данные, дожидается завершения ожидающих коммитов (с защитным таймаутом) и корректно останавливает фоновые задачи.
- `destroy(reason?)`: `void`
  - Немедленно останавливает все операции, отклоняет ожидающие коммиты, освобождает ресурсы.

## Writer

- `topic`: `string`
- `tx?`: `TX` — запись внутри транзакции
- `producer?`: `string`
- `codec?`: `CompressionCodec`
- `maxBufferBytes?`: `bigint` — по умолчанию 256 МБ
- `maxInflightCount?`: `number` — по умолчанию 1000
- `flushIntervalMs?`: `number` — по умолчанию 10 мс
- `updateTokenIntervalMs?`: `number` — по умолчанию 60000
- `retryConfig?(signal)`: `RetryConfig`
- `onAck?(seqNo, status?)`: `(seqNo: bigint, status?: 'skipped' | 'written' | 'writtenInTx') => void`

Методы и поведение:
- `write(payload: Uint8Array, extra?)`: `bigint`
  - Кладёт сообщение в буфер и возвращает назначенный `seqNo`. Опционально можно задать `seqNo`, `createdAt`, `metadataItems`. Запись не блокирует; фактическая отправка выполняется при `flush()` или периодическим флашером.
  - Почему `seqNo`: на продюсере `producerId + seqNo` обеспечивает идемпотентность и детерминизм подтверждений (и упорядоченность в партиции).
- `flush()`: `Promise<bigint | undefined>`
  - Выгружает накопленные сообщения в сеть, дожидается подтверждений «в полёте» и возвращает последний `seqNo`. Используйте в контрольных точках (например, при остановке сервиса).
- `close()`: `Promise<void>`
  - «Мягко» завершает работу: прекращает приём новых сообщений, дожидается флаша, освобождает ресурсы.
- `destroy()`: `void`
  - Немедленное прекращение без гарантии доставки.

Подтверждения:
- `onAck(seqNo, status)`: уведомляет о судьбе сообщения. `status`:
  - `written` — записано вне транзакции;
  - `writtenInTx` — записано в транзакции (станет видимым после коммита);
  - `skipped` — пропущено (например, из‑за конфликта `seqNo`).

Повторные попытки и устойчивость:
- Подключение к TopicService — потоковое; при обрывах переподнимается с бюджетом/стратегией из `retryConfig`. Очередь команд пересоздаётся.

Транзакционные варианты:
- `createTopicTxReader(tx, ...)` и `createTopicTxWriter(tx, ...)` привязаны к транзакции Query.
  - TxReader отслеживает прочитанные оффсеты и отправляет `updateOffsetsInTransaction` на `tx.onCommit`.
  - TxWriter инициирует `flush` на `tx.onCommit` и корректно сворачивается на `tx.onRollback/onClose`.
  - Эти объекты не реализуют `AsyncDisposable`; использовать `using` для них не нужно: жизненным циклом управляет транзакция.
