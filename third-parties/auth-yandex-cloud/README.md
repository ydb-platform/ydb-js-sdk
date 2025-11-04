# @ydbjs/auth-yandex-cloud

Yandex Cloud Service Account authentication provider for YDB. Supports authorized key JSON files and automatic IAM token management.

## Installation

```sh
npm install @ydbjs/auth-yandex-cloud
```

## Features

- **Service Account Key Authentication**: Authenticate using Yandex Cloud Service Account authorized key JSON files
- **Automatic IAM Token Management**: Creates JWT, exchanges it for IAM tokens, and caches them automatically
- **Token Refresh**: Automatically refreshes tokens before expiration (5 minute safety margin)
- **Retry Logic**: Built-in retry with exponential backoff for IAM API calls
- **Multiple Initialization Methods**: From file, environment variable, or direct JSON object

## Usage

### From File

```typescript
import { Driver } from '@ydbjs/core'
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'

let driver = new Driver('grpcs://ydb.serverless.yandexcloud.net:2135/database', {
  credentialsProvider: ServiceAccountCredentialsProvider.fromFile('./authorized_key.json'),
})

await driver.ready()
```

### From Environment Variable

```typescript
import { Driver } from '@ydbjs/core'
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'

// Set YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=/path/to/key.json
let driver = new Driver(connectionString, {
  credentialsProvider: ServiceAccountCredentialsProvider.fromEnv(),
})

await driver.ready()
```

### From JSON Object

```typescript
import { Driver } from '@ydbjs/core'
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'
import * as fs from 'fs'

let keyData = JSON.parse(fs.readFileSync('authorized_key.json', 'utf8'))

let driver = new Driver(connectionString, {
  credentialsProvider: new ServiceAccountCredentialsProvider(keyData),
})

await driver.ready()
```

### Custom IAM Endpoint

```typescript
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'

let provider = new ServiceAccountCredentialsProvider(keyData, {
  iamEndpoint: 'https://custom-iam-endpoint.com/iam/v1/tokens',
})
```

## Service Account Key Format

The authorized key JSON file should have the following structure:

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

Required fields:

- `id`: Key ID
- `service_account_id`: Service Account ID
- `private_key`: Private key in PEM format

## How It Works

1. **JWT Creation**: Creates a JWT signed with PS256 (RSA-PSS) algorithm using the private key
2. **IAM Token Exchange**: Sends JWT to Yandex Cloud IAM API (`https://iam.api.cloud.yandex.net/iam/v1/tokens`)
3. **Token Caching**: Caches the IAM token and automatically refreshes it before expiration (5 minute safety margin)
4. **YDB Authentication**: Uses the IAM token as `x-ydb-auth-ticket` header for YDB requests

## Security

- Never commit authorized key files to version control
- Use environment variables or secrets management in production
- Rotate keys regularly
- Grant minimal required permissions to Service Accounts

## Requirements

- Node.js >= 20.19
- Valid Yandex Cloud Service Account authorized key

## License

Apache-2.0
