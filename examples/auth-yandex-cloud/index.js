/**
 * YDB Service Account Authentication Example
 *
 * Демонстрирует подключение к YDB используя Yandex Cloud Service Account authorized key:
 * - Авторизация через Service Account ключ
 * - Создание credentials provider из файла
 * - Выполнение простого запроса для проверки подключения
 * - Правильное управление ресурсами
 *
 * Для запуска:
 * 1. Убедитесь, что у вас есть файл authorized_key.json с ключом Service Account
 * 2. Установите переменную YDB_CONNECTION_STRING (опционально)
 * 3. Запустите: npm start
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud'

let connectionString =
	process.env.YDB_CONNECTION_STRING ||
	'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/.../...'

// Path to authorized key file (relative to this file)
let keyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../authorized_key.json')

console.log('🔑 Using Service Account key from:', keyPath)
console.log('🔗 Connecting to:', connectionString)

let credentialsProvider = ServiceAccountCredentialsProvider.fromFile(keyPath)
let driver = new Driver(connectionString, {
	credentialsProvider,
})

console.log('⏳ Waiting for driver to be ready...')

try {
	await driver.ready()
	console.log('✅ Driver is ready!')

	// Test simple query
	let sql = query(driver)
	let [[result]] = await sql`SELECT 1 as test_value`

	console.log('✅ Query executed successfully!')
	console.log('📊 Result:', result)

	console.log('✅ Connection test passed!')
} catch (error) {
	console.error('❌ Error:', error.message)
	if (error.issues) {
		console.error('🔍 Issues:', JSON.stringify(error.issues, null, 2))
	}
	if (error.cause) {
		console.error('🔍 Cause:', error.cause)
	}
	throw error
} finally {
	driver.close()
	console.log('🔄 Connection closed')
}
