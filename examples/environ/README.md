# Environment-based Authentication Example

This example demonstrates how to use `EnvironCredentialsProvider` to auto-detect the authentication method and TLS configuration from environment variables.

## Usage

```bash
# Anonymous (local YDB)
YDB_CONNECTION_STRING=grpc://localhost:2136/local npm start

# Static credentials (on-premises)
YDB_CONNECTION_STRING=grpcs://ydb.example.com:2135/mydb \
YDB_STATIC_CREDENTIALS_USER=admin \
YDB_STATIC_CREDENTIALS_PASSWORD=secret \
YDB_SSL_ROOT_CERTIFICATES_FILE=/path/to/ca.pem \
npm start

# Access token
YDB_CONNECTION_STRING=grpcs://ydb.example.com:2135/mydb \
YDB_ACCESS_TOKEN_CREDENTIALS=my-token \
npm start

# Metadata (cloud VM)
YDB_CONNECTION_STRING=grpcs://ydb.example.com:2135/mydb \
YDB_METADATA_CREDENTIALS=1 \
npm start
```

## Environment Variables

### Credentials (first match wins)

| Variable                            | Description                                             |
| ----------------------------------- | ------------------------------------------------------- |
| `YDB_ANONYMOUS_CREDENTIALS=1`       | Anonymous access                                        |
| `YDB_METADATA_CREDENTIALS=1`        | Cloud metadata token                                    |
| `YDB_METADATA_CREDENTIALS_ENDPOINT` | Custom metadata endpoint (default: GCE metadata)        |
| `YDB_METADATA_CREDENTIALS_FLAVOR`   | Custom metadata flavor (default: `Google`)              |
| `YDB_ACCESS_TOKEN_CREDENTIALS`      | Direct access token                                     |
| `YDB_STATIC_CREDENTIALS_USER`       | Username for static auth                                |
| `YDB_STATIC_CREDENTIALS_PASSWORD`   | Password (default: empty)                               |
| `YDB_STATIC_CREDENTIALS_ENDPOINT`   | Auth endpoint (default: derived from connection string) |

### TLS (file path or PEM string)

| File variant                     | String variant              | Description        |
| -------------------------------- | --------------------------- | ------------------ |
| `YDB_SSL_ROOT_CERTIFICATES_FILE` | `YDB_SSL_ROOT_CERTIFICATES` | CA certificate     |
| `YDB_SSL_CERTIFICATE_FILE`       | `YDB_SSL_CERTIFICATE`       | Client certificate |
| `YDB_SSL_PRIVATE_KEY_FILE`       | `YDB_SSL_PRIVATE_KEY`       | Client private key |

`NODE_EXTRA_CA_CERTS` is also supported as a CA file path fallback.
