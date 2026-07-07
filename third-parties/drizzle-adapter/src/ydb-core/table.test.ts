import { expect, test } from 'vitest'
import { Table, getTableName } from 'drizzle-orm/table'
import { sql as yql } from 'drizzle-orm'
import { customType, integer, text, uuid, ydbTable, ydbTableCreator } from '../schema.ts'
import { getYdbColumnBuilders, ydbColumnBuilders } from '../ydb-core/columns/all.ts'
import { YdbColumn } from '../ydb-core/columns/common.ts'
import { getTableConfig } from '../ydb-core/table.utils.ts'

let typedTable = ydbTable('typed_table', {
	id: integer('id').notNull().$type<1 | 2>(),
	payload: text('payload').$type<{ pony: string }>(),
	meta: text('meta').notNull().$type<{ level: number }>(),
})

void typedTable

test('exposes declared columns on YDB tables', () => {
	let table = ydbTable('ponies', {
		id: uuid('id').notNull(),
		price: integer('price').notNull(),
		name: text('name').notNull(),
	})

	let columns = (table as any)[(Table as any).Symbol.Columns]
	let extraColumns = (table as any)[(Table as any).Symbol.ExtraConfigColumns]

	expect(getTableName(table)).toBe('ponies')
	expect(table.id.name).toBe('id')
	expect(table.name.name).toBe('name')
	expect(columns.id).toBe(table.id)
	expect(columns.name).toBe(table.name)
	expect(extraColumns.id).toBe(table.id)
	expect(extraColumns.name).toBe(table.name)
})

test('invokes the table extras callback with column refs', () => {
	let callbackTable = ydbTable('mares', ({ integer: int, text: textType }) => ({
		id: int('id').notNull(),
		name: textType('name').notNull(),
	}))
	let prefixedTable = ydbTableCreator((name) => `app_${name}`)('users', {
		id: integer('id').notNull(),
	})

	expect(getTableName(callbackTable)).toBe('mares')
	expect(getTableName(prefixedTable)).toBe('app_users')
	expect(callbackTable.id.name).toBe('id')
	expect(callbackTable.name.name).toBe('name')
})

test('provides column builders for YDB types', () => {
	let firstRegistry = getYdbColumnBuilders()
	let secondRegistry = getYdbColumnBuilders()
	let callbackCalls: unknown[] = []

	let table = ydbTable('registry_check', (builders) => {
		callbackCalls.push(builders)

		expect(builders).toBe(ydbColumnBuilders)
		expect(builders).toBe(firstRegistry)
		expect(firstRegistry).toBe(secondRegistry)
		expect(builders.int).toBe(builders.integer)

		return {
			id: builders.int('id').notNull(),
			payload: builders.text('payload'),
		}
	})

	expect(callbackCalls.length).toBe(1)
	expect(table.id.name).toBe('id')
	expect(table.payload.name).toBe('payload')
})

test('attaches builder metadata to columns', () => {
	let table = ydbTable('builder_columns', {
		id: integer('id')
			.notNull()
			.default(1)
			.$defaultFn(() => 2)
			.$onUpdateFn(() => 3)
			.primaryKey(),
		plain: text('plain'),
	})

	let idColumn = table.id
	let plainColumn = table.plain as YdbColumn

	expect(idColumn.notNull).toBe(true)
	expect(idColumn.default).toBe(1)
	expect(idColumn.defaultFn?.()).toBe(2)
	expect(idColumn.onUpdateFn?.()).toBe(3)
	expect(idColumn.primary).toBe(true)
	expect(plainColumn.getSQLType()).toBe('Utf8')
	expect(new YdbColumn(table, (plainColumn as any).config).getSQLType()).toBe('unknown')
	expect(plainColumn.mapToDriverValue('Rarity')).toBe('Rarity')
	expect(plainColumn.mapFromDriverValue('Rarity')).toBe('Rarity')
})

test('rejects generatedAlwaysAs on YDB columns', () => {
	expect(() => integer('id').generatedAlwaysAs(() => yql`1`)).toThrow(
		/generatedAlwaysAs\(\) is not supported/u
	)
})

test('supports custom column definitions', () => {
	let uppercase = customType<{ data: string; driverData: string }>({
		dataType() {
			return 'Utf8'
		},
		toDriver(value) {
			return value.toUpperCase()
		},
		fromDriver(value) {
			return value.toLowerCase()
		},
	})
	let withConfig = customType<{ data: string; driverData: string; config: { prefix: string } }>({
		dataType(config) {
			return config?.prefix ? 'Utf8' : 'String'
		},
		toDriver(value) {
			return `cfg:${value}`
		},
	})

	let table = ydbTable('custom_columns', {
		upper: uppercase('upper'),
		configured: withConfig('configured', { prefix: 'pony' }),
	})

	expect(table.upper.getSQLType()).toBe('Utf8')
	expect(table.upper.mapToDriverValue('pinkie')).toBe('PINKIE')
	expect(table.upper.mapFromDriverValue('PINKIE')).toBe('pinkie')
	expect(table.configured.getSQLType()).toBe('Utf8')
	expect(table.configured.mapToDriverValue('dash')).toBe('cfg:dash')
})

test('tracks unique metadata on columns', () => {
	let users = ydbTable('constraint_users', {
		id: integer('id').notNull().primaryKey(),
		email: text('email').notNull().unique(),
		externalId: text('external_id').unique('constraint_users_external_unique'),
	})

	let usersConfig = getTableConfig(users)

	expect(
		usersConfig.uniqueConstraints.map((constraint) => constraint.config.name).sort()
	).toEqual(['constraint_users_email_unique', 'constraint_users_external_unique'])
})
