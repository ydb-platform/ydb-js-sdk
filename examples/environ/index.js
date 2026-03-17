import { Driver } from '@ydbjs/core'
import { EnvironCredentialsProvider } from '@ydbjs/auth/environ'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

let cs = process.env.YDB_CONNECTION_STRING
if (!cs) throw new Error('YDB_CONNECTION_STRING is required')

// Auto-detect auth method and TLS from environment variables.
//
// Credentials (first match wins):
//   YDB_ANONYMOUS_CREDENTIALS=1
//   YDB_METADATA_CREDENTIALS=1  (+ YDB_METADATA_CREDENTIALS_ENDPOINT, YDB_METADATA_CREDENTIALS_FLAVOR)
//   YDB_ACCESS_TOKEN_CREDENTIALS=<token>
//   YDB_STATIC_CREDENTIALS_USER=<user>  (+ YDB_STATIC_CREDENTIALS_PASSWORD, YDB_STATIC_CREDENTIALS_ENDPOINT)
//
// TLS (file path or PEM string):
//   YDB_SSL_ROOT_CERTIFICATES_FILE / YDB_SSL_ROOT_CERTIFICATES
//   YDB_SSL_CERTIFICATE_FILE      / YDB_SSL_CERTIFICATE
//   YDB_SSL_PRIVATE_KEY_FILE      / YDB_SSL_PRIVATE_KEY
let creds = new EnvironCredentialsProvider(cs)

let driver = new Driver(cs, {
	credentialsProvider: creds,
	secureOptions: creds.secureOptions,
})

await driver.ready()
console.log('Connected to', cs)

let discovery = driver.createClient(DiscoveryServiceDefinition)
let resp = await discovery.listEndpoints({ database: driver.database })
console.log('Endpoints status:', resp.status)

driver.close()
console.log('Done')
