import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const packageJsonPath = resolve(packageDir, 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

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

const publicApi = await import('@ydbjs/drizzle-adapter')
const expectedRuntimeExports = [
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

for (const name of expectedRuntimeExports) {
	assert.equal(Object.hasOwn(publicApi, name), true, `Missing root runtime export: ${name}`)
}

const internalRuntimeExports = [
	'YdbColumn',
	'YdbColumnBuilder',
	'YdbCountBuilder',
	'YdbDatabase',
	'YdbDialect',
	'YdbQueryBuilder',
	'YdbSession',
	'YdbTransaction',
]

for (const name of internalRuntimeExports) {
	assert.equal(
		Object.hasOwn(publicApi, name),
		false,
		`Root public API exposes implementation detail: ${name}`
	)
}

const forbiddenSubpaths = [
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

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
	cwd: packageDir,
	encoding: 'utf8',
})

assert.equal(pack.status, 0, pack.stderr || pack.stdout)

const packManifest = JSON.parse(pack.stdout)[0]
const packedFiles = new Set(packManifest.files.map((file) => file.path))

for (const file of [
	'package.json',
	'README.md',
	'CHANGELOG.md',
	'dist/index.js',
	'dist/index.d.ts',
]) {
	assert.equal(packedFiles.has(file), true, `Packed package is missing ${file}`)
}

for (const file of packedFiles) {
	assert.equal(file.startsWith('src/'), false, `Source file leaked into package: ${file}`)
	assert.equal(file.startsWith('tests/'), false, `Test file leaked into package: ${file}`)
}

console.log('drizzle-adapter package surface is stable')
