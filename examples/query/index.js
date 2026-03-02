/**
 * YDB Query Example
 *
 * Демонстрирует основные возможности YDB JavaScript SDK:
 * - Выполнение SQL-запросов с параметрами
 * - Создание таблиц и работа с данными
 * - Работа с JSON данными (хранение как строка, запросы через JSON функции)
 * - Правильное управление ресурсами
 *
 * Для запуска:
 * 1. Убедитесь, что YDB запущена локально
 * 2. Установите переменную YDB_CONNECTION_STRING (опционально)
 * 3. Запустите: npm start
 * 4. Для отладки: npm run dev
 */

import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Json, Timestamp, Uint64 } from '@ydbjs/value/primitive'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let sql = query(driver)

await driver.ready()

try {
	// Создаем пример таблицы
	await sql`CREATE TABLE IF NOT EXISTS test_table (
		id Uint64,
		title Text,
		content Text,
		created_at Timestamp,
		metadata Json,
		PRIMARY KEY (id)
	)`

	console.log('✅ Таблица создана')

	// Очищаем таблицу для примера
	await sql`DELETE FROM test_table`
	console.log('🗑️  Таблица очищена')

	// Подготавливаем YDB данные (только специальные типы указываем явно)
	let ydbData = [
		{
			id: new Uint64(1n),
			title: 'Первая запись', // string автоматически станет Text
			content: 'Содержимое первой записи',
			created_at: new Timestamp(new Date()),
			metadata: new Json(JSON.stringify({ tags: ['example', 'test'] })),
		},
		{
			id: new Uint64(2n),
			title: 'Вторая запись',
			content: 'Содержимое второй записи',
			created_at: new Timestamp(new Date()),
			metadata: new Json(JSON.stringify({ tags: ['example'], priority: 'high' })),
		},
		{
			id: new Uint64(3n),
			title: 'Третья запись',
			content: 'Содержимое третьей записи',
			created_at: new Timestamp(new Date()),
			metadata: new Json(JSON.stringify({ tags: ['test'], priority: 'low' })),
		},
	]

	// Вставляем данные
	let insertQuery = sql`INSERT INTO test_table SELECT * FROM AS_TABLE(${ydbData})`

	// Отладочная информация
	console.log('🔍 SQL текст:', insertQuery.text)
	console.log('🔍 Параметры:', Object.keys(insertQuery.parameters))
	console.log(
		'🔍 Типы параметров:',
		Object.entries(insertQuery.parameters).map(([key, value]) => [
			key,
			value.constructor.name,
			value.type?.constructor.name,
		])
	)

	await insertQuery

	console.log('✅ Данные вставлены')

	// Выполняем запрос с параметром
	let searchId = 2n
	let [[foundRecord]] = await sql`
		SELECT id, title, content, metadata
		FROM test_table
		WHERE id = ${searchId}`

	console.log('🔍 Найденная запись:', foundRecord)

	// Подсчитываем общее количество записей
	let [[countResult]] = await sql`SELECT COUNT(*) as total FROM test_table`
	console.log('📊 Всего записей:', countResult.total)

	// Получаем записи с определенными тегами (упрощенный JSON запрос)
	let recordsWithTag = await sql`
		SELECT id, title
		FROM test_table
		WHERE JSON_EXISTS(metadata, "$.tags[*]")`

	console.log('🏷️  Записи с тегами:', recordsWithTag[0])

	console.log('✅ Пример успешно выполнен!')
} catch (error) {
	console.error('❌ Ошибка:', error.message)
	console.error('🔍 Детальная информация об ошибке:')
	console.error(JSON.stringify(error.issues, null, 2))
	throw error
} finally {
	// Очищаем ресурсы
	driver.close()
	console.log('🔄 Соединение закрыто')
}
