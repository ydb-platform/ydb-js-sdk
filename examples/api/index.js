/**
 * YDB API Example
 *
 * Демонстрирует основные возможности низкоуровневого gRPC API YDB:
 * - Подключение и аутентификация
 * - Discovery сервис (endpoint'ы и информация о пользователе)
 * - Scheme сервис (просмотр структуры базы данных)
 *
 * Для запуска:
 * 1. Убедитесь, что YDB запущена локально
 * 2. Запустите: npm start
 */

import { anyUnpack } from '@bufbuild/protobuf/wkt'
import {
	DiscoveryServiceDefinition,
	ListEndpointsResultSchema,
	WhoAmIResultSchema,
} from '@ydbjs/api/discovery'
import { ListDirectoryResultSchema, SchemeServiceDefinition } from '@ydbjs/api/scheme'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'

let driver = new Driver(connectionString, {
	credentialsProvider: new StaticCredentialsProvider(
		{ username: 'root', password: '1234' },
		connectionString
	),
})

console.log('🔗 Подключение к YDB:', connectionString)

await driver.ready()
console.log('✅ Подключение установлено')

let discovery = driver.createClient(DiscoveryServiceDefinition)

// Получаем endpoint'ы
console.log("\n📡 Доступные endpoint'ы:")
{
	let response = await discovery.listEndpoints({ database: driver.database })
	let endpoints = anyUnpack(response.operation.result, ListEndpointsResultSchema)

	console.log(`   Всего: ${endpoints?.endpoints?.length || 0}`)
	endpoints?.endpoints?.forEach((endpoint, index) => {
		let ssl = endpoint?.ssl ? ' (SSL)' : ''
		console.log(`   ${index + 1}. ${endpoint?.address}:${endpoint?.port}${ssl}`)
	})
}

// Получаем информацию о пользователе
console.log('\n🆔 Информация о пользователе:')
{
	let response = await discovery.whoAmI({})
	let whoAmI = anyUnpack(response.operation.result, WhoAmIResultSchema)

	console.log(`   Пользователь: ${whoAmI?.user || 'анонимный'}`)
	console.log(`   Группы: ${whoAmI?.groups?.join(', ') || 'нет'}`)
}

// Просматриваем структуру базы данных
console.log('\n📁 Содержимое базы данных:')
{
	let scheme = driver.createClient(SchemeServiceDefinition)
	let response = await scheme.listDirectory({ path: driver.database })
	let directoryResult = anyUnpack(response.operation.result, ListDirectoryResultSchema)

	console.log(`   Путь: ${driver.database}`)
	console.log(`   Владелец: ${directoryResult?.self?.owner || 'неизвестно'}`)
	console.log(`   Объектов: ${directoryResult?.children?.length || 0}`)

	if (directoryResult?.children) {
		let sortedChildren = [...directoryResult.children].sort((a, b) =>
			(a?.name || '').localeCompare(b?.name || '')
		)

		sortedChildren.forEach((child, index) => {
			let name = child?.name || 'неизвестно'
			let isSystem = name.startsWith('.sys') ? ' 🔧' : ''
			console.log(`   ${index + 1}. ${name} (тип: ${child?.type || 'неизвестно'})${isSystem}`)
		})
	}
}

driver.close()
console.log('\n✅ Готово!')
