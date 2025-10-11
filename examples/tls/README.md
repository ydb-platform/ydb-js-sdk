# TLS/mTLS Examples

Демонстрация подключения по TLS и mTLS:

- TLS c кастомным CA
- mTLS (client cert + key)
- StaticCredentialsProvider с TLS/mTLS к AuthService

## Переменные окружения

```bash
export YDB_CONNECTION_STRING=grpcs://ydb.example.com:2135/your-db
export YDB_CA=/path/to/ca.pem
export YDB_CERT=/path/to/client.crt # для mTLS
export YDB_KEY=/path/to/client.key  # для mTLS
export YDB_AUTH_ENDPOINT=grpcs://ydb.example.com:2135
export YDB_USER=user
export YDB_PASSWORD=pass
```

## Запуск

```bash
cd examples/tls
npm install
npm start
```

