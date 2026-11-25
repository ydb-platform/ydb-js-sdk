import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Json, Timestamp, Uint64 } from '@ydbjs/value/primitive'

let connectionString = process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let sql = query(driver)

try {
	await driver.ready()

	// Use a disposable database: this example clears test_table.
	await sql`CREATE TABLE IF NOT EXISTS test_table (
		id Uint64,
		title Text,
		content Text,
		created_at Timestamp,
		metadata Json,
		PRIMARY KEY (id)
	)`

	console.log('✅ Таблица создана')

	await sql`DELETE FROM test_table`
	console.log('🗑️  Таблица очищена')

	// Match the table schema where JavaScript inference would choose another YDB type.
	let ydbData = [
		{
			id: new Uint64(1n),
			title: 'Первая запись',
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

	let insertQuery = sql`INSERT INTO test_table SELECT * FROM AS_TABLE(${ydbData})`

	await insertQuery

	console.log('✅ Данные вставлены')

	let searchId = new Uint64(2n)
	let [[foundRecord]] = await sql`
		SELECT id, title, content, metadata
		FROM test_table
		WHERE id = ${searchId}`

	console.log('🔍 Найденная запись:', foundRecord)

	let [[countResult]] = await sql`SELECT COUNT(*) as total FROM test_table`
	console.log('📊 Всего записей:', countResult.total)

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
	try {
		await sql.close()
	} finally {
		driver.close()
	}

	console.log('🔄 Соединение закрыто')
}
