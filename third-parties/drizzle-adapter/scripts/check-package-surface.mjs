import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let scriptDir = dirname(fileURLToPath(import.meta.url))
let packageDir = resolve(scriptDir, '..')
let packageJsonPath = resolve(packageDir, 'package.json')
let packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

assert.equal(packageJson.type, 'module')
assert.equal(packageJson.sideEffects, false)
assert.equal(packageJson.main, 'dist/index.js')
assert.equal(packageJson.types, 'dist/index.d.ts')
assert.deepEqual(packageJson.exports, {
	'.': {
		types: './dist/index.d.ts',
		import: './dist/index.js',
	},
	'./schema': {
		types: './dist/schema.d.ts',
		import: './dist/schema.js',
	},
	'./sql': {
		types: './dist/sql.d.ts',
		import: './dist/sql.js',
	},
	'./migrator': {
		types: './dist/migrator.d.ts',
		import: './dist/migrator.js',
	},
})

let entryExpectations = {
	'@ydbjs/drizzle-adapter': [
		'YdbAuthenticationError',
		'YdbCancelledQueryError',
		'YdbDriver',
		'YdbOverloadedQueryError',
		'YdbQueryExecutionError',
		'YdbRetryableQueryError',
		'YdbTimeoutQueryError',
		'YdbUnavailableQueryError',
		'YdbUniqueConstraintViolationError',
		'createDrizzle',
		'drizzle',
		'many',
		'one',
		'relations',
	],
	'@ydbjs/drizzle-adapter/schema': ['integer', 'primaryKey', 'text', 'unique', 'ydbTable'],
	'@ydbjs/drizzle-adapter/sql': ['numericHash', 'currentUtcTimestamp', 'pragma', 'yqlScript'],
	'@ydbjs/drizzle-adapter/migrator': ['buildCreateTableSql', 'migrate'],
}

let [publicApi, schemaApi, sqlApi, migratorApi] = await Promise.all(
	Object.keys(entryExpectations).map((specifier) => import(specifier))
)
let loadedEntries = {
	'@ydbjs/drizzle-adapter': publicApi,
	'@ydbjs/drizzle-adapter/schema': schemaApi,
	'@ydbjs/drizzle-adapter/sql': sqlApi,
	'@ydbjs/drizzle-adapter/migrator': migratorApi,
}
for (let [specifier, expected] of Object.entries(entryExpectations)) {
	let mod = loadedEntries[specifier]
	for (let name of expected) {
		assert.equal(Object.hasOwn(mod, name), true, `Missing export from ${specifier}: ${name}`)
	}
}

// Implementation details must not leak from the root entrypoint.
let rootInternalLeaks = [
	'YdbColumn',
	'YdbColumnBuilder',
	'YdbCountBuilder',
	'YdbDatabase',
	'YdbDialect',
	'YdbQueryBuilder',
	'YdbSession',
	'YdbTransaction',
]
for (let name of rootInternalLeaks) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`Root public API exposes implementation detail: ${name}`
	)
}

// Cross-entry hygiene: schema-only symbols don't leak into the root, DDL
// builders don't leak into /schema or /sql, etc.
for (let name of ['ydbTable', 'integer', 'text', 'primaryKey']) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`Schema helper leaked into root entry: ${name}`
	)
}

for (let name of ['numericHash', 'pragma', 'yqlScript']) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`SQL helper leaked into root entry: ${name}`
	)
	assert.equal(
		Object.hasOwn(schemaApi, name),
		false,
		`SQL helper leaked into /schema entry: ${name}`
	)
}

for (let name of ['migrate', 'buildCreateTableSql']) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`Migrator symbol leaked into root entry: ${name}`
	)
	assert.equal(
		Object.hasOwn(schemaApi, name),
		false,
		`Migrator symbol leaked into /schema entry: ${name}`
	)
	assert.equal(
		Object.hasOwn(sqlApi, name),
		false,
		`Migrator symbol leaked into /sql entry: ${name}`
	)
}

let forbiddenSubpaths = [
	'@ydbjs/drizzle-adapter/dist/index.js',
	'@ydbjs/drizzle-adapter/ydb/dialect.js',
	'@ydbjs/drizzle-adapter/ydb-core/session.js',
]

await Promise.all(
	forbiddenSubpaths.map(async (subpath) => {
		try {
			await import(subpath)
			assert.fail(`Deep import unexpectedly resolved: ${subpath}`)
		} catch (error) {
			assert.equal(
				error?.code,
				'ERR_PACKAGE_PATH_NOT_EXPORTED',
				`Unexpected error for ${subpath}: ${error?.code ?? error}`
			)
		}
	})
)

let pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
	cwd: packageDir,
	encoding: 'utf8',
})

assert.equal(pack.status, 0, pack.stderr || pack.stdout)

let packManifest = JSON.parse(pack.stdout)[0]
let packedFiles = new Set(packManifest.files.map((file) => file.path))

for (let file of [
	'package.json',
	'README.md',
	'CHANGELOG.md',
	'dist/index.js',
	'dist/index.d.ts',
	'dist/schema.js',
	'dist/schema.d.ts',
	'dist/sql.js',
	'dist/sql.d.ts',
	'dist/migrator.js',
	'dist/migrator.d.ts',
]) {
	assert.equal(packedFiles.has(file), true, `Packed package is missing ${file}`)
}

for (let file of packedFiles) {
	assert.equal(file.startsWith('src/'), false, `Source file leaked into package: ${file}`)
	assert.equal(file.startsWith('tests/'), false, `Test file leaked into package: ${file}`)
}

console.log('drizzle-adapter package surface is stable')
