import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

/**
 * ✅ ПРАВИЛЬНЫЙ пример для serverless окружений
 *
 * ВАЖНО: Драйвер создается ВНУТРИ handler функции!
 * Не выносите Driver в глобальную область - HTTP/2 соединения
 * не работают корректно при переиспользовании между вызовами
 * функции в serverless окружениях.
 */
export async function handler(_event) {
	// Создаем драйвер внутри handler
	let credentialsProvider = new MetadataCredentialsProvider()
	let driver = new Driver(process.env.YDB_CONNECTION_STRING, {
		credentialsProvider,
		'ydb.sdk.enable_discovery': false, // Улучшает производительность холодного старта
	})

	try {
		await driver.ready()
		let sql = query(driver)

		// Выполняем запрос
		let resultSets = await sql`SELECT 1 + 1 AS sum`

		return {
			statusCode: 200,
			body: {
				resultSets, // [ { sum: 2 } ]
			},
		}
	} finally {
		// ОБЯЗАТЕЛЬНО закрываем драйвер
		driver.close()
	}
}

// Для локального тестирования
if (import.meta.url === `file://${process.argv[1]}`) {
	handler({})
		.then((result) => {
			console.log('Result:', result)
			return result
		})
		.catch((error) => {
			console.error('Error:', error)
			process.exit(1)
		})
}
