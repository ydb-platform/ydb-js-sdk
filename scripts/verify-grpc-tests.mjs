import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

let [resultsPath, witnessPath, outputPath] = process.argv.slice(2)
let errors = []
let summary = {
	runtime: process.env.GRPC_TEST_RUNTIME,
	expectedVersion: process.env.GRPC_TEST_VERSION,
	valid: false,
	errors,
}

try {
	let results = JSON.parse(await readFile(resultsPath, 'utf8'))
	let witness = (await readFile(witnessPath, 'utf8'))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
	let unitFiles = (await readdir('packages/grpc/src', { recursive: true }))
		.filter((name) => name.endsWith('.test.ts'))
		.map((name) => `packages/grpc/src/${name}`)
	let interopFile = 'packages/grpc/interop/interop.test.ts'
	let expectedFiles = [...unitFiles, interopFile].sort()
	let actualFiles = results.testResults.map((file) => relative(process.cwd(), file.name)).sort()
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
		errors.push('Missing or unexpected test files')
	if (!results.success || results.numFailedTests || results.numFailedTestSuites)
		errors.push('Tests failed')
	if (results.numPendingTests || results.numTodoTests || results.numPendingTestSuites)
		errors.push('Skipped or todo tests')

	let expected = new Map()
	let unitCount = 0
	let interopCount = 0
	for (let file of results.testResults) {
		let path = relative(process.cwd(), file.name)
		if (file.status !== 'passed' || file.assertionResults.length === 0)
			errors.push(`Incomplete test file: ${path}`)
		for (let test of file.assertionResults) {
			let key = JSON.stringify([path, test.title])
			if (test.status !== 'passed' || expected.has(key))
				errors.push(`Incomplete or duplicate test: ${key}`)
			expected.set(key, false)
			if (path === interopFile) interopCount++
			else unitCount++
		}
	}
	if (unitCount < 130 || interopCount < 13)
		errors.push('Expected all 130 transport cases and 13 Go interoperability cases')
	if (results.numTotalTests !== expected.size || results.numPassedTests !== expected.size)
		errors.push('Test counts differ')

	for (let record of witness) {
		let key = JSON.stringify([record.file, record.name])
		if (!expected.has(key) || expected.get(key))
			errors.push(`Unexpected or duplicate worker witness: ${key}`)
		expected.set(key, true)
		if (
			record.runtime !== summary.runtime ||
			(record.version !== summary.expectedVersion &&
				!(
					record.runtime === 'node' &&
					record.version.split('.')[0] === summary.expectedVersion
				))
		)
			errors.push(`Wrong worker runtime: ${record.runtime} ${record.version}`)
		if (!record.executable || !Number.isInteger(record.pid) || record.pid <= 0)
			errors.push('Missing worker identity')
	}
	if (witness.length !== results.numTotalTests || [...expected.values()].some((seen) => !seen)) {
		errors.push('Every test must have exactly one worker runtime witness')
	}
	Object.assign(summary, {
		total: results.numTotalTests,
		passed: results.numPassedTests,
		unitCount,
		interopCount,
		workerWitnesses: witness.length,
		versions: [...new Set(witness.map((record) => record.version))],
		executables: [...new Set(witness.map((record) => record.executable))],
		workerPids: [...new Set(witness.map((record) => record.pid))],
		files: actualFiles,
	})
} catch (error) {
	errors.push(String(error))
}

summary.valid = errors.length === 0
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n')
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
if (!summary.valid) process.exitCode = 1
