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
})

let publicApi = await import('@ydbjs/drizzle-adapter')
let expectedRuntimeExports = [
	'YdbAuthenticationError',
	'YdbCancelledQueryError',
	'YdbDriver',
	'YdbOverloadedQueryError',
	'YdbQueryExecutionError',
	'YdbRetryableQueryError',
	'YdbTimeoutQueryError',
	'YdbUnavailableQueryError',
	'YdbUniqueConstraintViolationError',
	'asTable',
	'buildCreateTableSql',
	'createDrizzle',
	'drizzle',
	'index',
	'integer',
	'many',
	'migrate',
	'one',
	'primaryKey',
	'relations',
	'text',
	'unique',
	'ydbTable',
]

for (let name of expectedRuntimeExports) {
	assert.equal(Object.hasOwn(publicApi, name), true, `Missing root runtime export: ${name}`)
}

let internalRuntimeExports = [
	'YdbColumn',
	'YdbColumnBuilder',
	'YdbCountBuilder',
	'YdbDatabase',
	'YdbDialect',
	'YdbQueryBuilder',
	'YdbSession',
	'YdbTransaction',
]

for (let name of internalRuntimeExports) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`Root public API exposes implementation detail: ${name}`
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
]) {
	assert.equal(packedFiles.has(file), true, `Packed package is missing ${file}`)
}

for (let file of packedFiles) {
	assert.equal(file.startsWith('src/'), false, `Source file leaked into package: ${file}`)
	assert.equal(file.startsWith('tests/'), false, `Test file leaked into package: ${file}`)
}

console.log('drizzle-adapter package surface is stable')
