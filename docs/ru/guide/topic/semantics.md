---
title: Topic — семантика
---

# Семантика Topic Reader/Writer

## Reader

- Потоковая модель: сервер шлёт пачки сообщений по активным partition‑сессиям.
- `read({ limit, waitMs, signal })` — асинхронный итератор батчей;
  - `limit` — максимум сообщений за вызов итерации (по умолчанию нет лимита).
  - `waitMs` — максимум ожидания данных до возврата пустого батча.
  - `signal` — отмена ожидания/чтения.
- Коммиты: `commit(batch|msg)` — подтверждает обработку на стороне сервера.
- Hooks:
  - `onPartitionSessionStart(session, committedOffset, { start, end })` — можно сдвинуть `readOffset`/`commitOffset`.
  - `onPartitionSessionStop(session, committedOffset)` — финализация/коммиты.
  - `onCommittedOffset(session, committedOffset)` — уведомления об ack.

Буферизация:

- Внутренний буфер ограничивается `maxBufferBytes`.
- `codecMap` управляет распаковкой полезной нагрузки.

## Writer

- `write(payload)` — кладёт сообщение в буфер; возвращает `seqNo`.
- `flush()` — отправляет буфер на сервер; возвращает последний `seqNo`.
- `onAck(seqNo, status)` — уведомления о подтверждении записи.
- Ограничения: `maxBufferBytes`, `maxInflightCount`, `flushIntervalMs`.
- Прозрачный реконнект на уровне stream (экспоненциальная задержка + jitter), ограничен `recoveryWindowMs`.

## Транзакции

- TxReader: отслеживает прочитанные оффсеты и отправляет `updateOffsetsInTransaction` на коммите транзакции.
- TxWriter: дожидается `flush` перед коммитом (через `tx.onCommit`).
- Использование без `using`; управление жизненным циклом через хуки транзакции.
