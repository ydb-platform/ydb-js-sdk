import fs from 'node:fs'
import { Driver } from '@ydbjs/core'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { DiscoveryServiceDefinition } from '@ydbjs/api/discovery'

let cs = process.env.YDB_CONNECTION_STRING
if (!cs) throw new Error('YDB_CONNECTION_STRING is required')

let ca = process.env.YDB_CA ? fs.readFileSync(process.env.YDB_CA) : undefined
let cert = process.env.YDB_CERT ? fs.readFileSync(process.env.YDB_CERT) : undefined
let key = process.env.YDB_KEY ? fs.readFileSync(process.env.YDB_KEY) : undefined

// 1) TLS/mTLS в Driver (custom CA / client cert)
let driver = new Driver(cs, {
	secureOptions: {
		...(ca && { ca }),
		...(cert && { cert }),
		...(key && { key }),
		// servername: 'ydb.example.com', // при необходимости SNI
	},
})

await driver.ready()
console.log('Connected to', cs)

// 2) StaticCredentialsProvider с TLS/mTLS к AuthService
if (process.env.YDB_USER && process.env.YDB_PASSWORD && process.env.YDB_AUTH_ENDPOINT) {
	let provider = new StaticCredentialsProvider(
		{ username: process.env.YDB_USER, password: process.env.YDB_PASSWORD },
		process.env.YDB_AUTH_ENDPOINT,
		{
			...(ca && { ca }),
			...(cert && { cert }),
			...(key && { key }),
		}
	)

	let driverWithAuth = new Driver(cs, {
		secureOptions: {
			...(ca && { ca }),
			...(cert && { cert }),
			...(key && { key }),
		},
		credentialsProvider: provider,
	})
	await driverWithAuth.ready()
	console.log('Connected with StaticCredentialsProvider over TLS/mTLS')
	driverWithAuth.close()
}

// Проверка Discovery
let discovery = driver.createClient(DiscoveryServiceDefinition)
let resp = await discovery.listEndpoints({ database: driver.database })
console.log('Endpoints status:', resp.status)

driver.close()
console.log('Done')
