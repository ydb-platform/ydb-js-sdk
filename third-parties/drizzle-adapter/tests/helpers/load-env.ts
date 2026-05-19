import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let envLoaded = false

function parseEnvLine(line: string): [string, string] | undefined {
	let trimmed = line.trim()

	if (trimmed === '' || trimmed.startsWith('#')) {
		return undefined
	}

	let equalsIndex = trimmed.indexOf('=')
	if (equalsIndex <= 0) {
		return undefined
	}

	let key = trimmed.slice(0, equalsIndex).trim()
	let value = trimmed.slice(equalsIndex + 1).trim()

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1)
	}

	return [key, value]
}

export function loadTestEnv(): void {
	if (envLoaded) {
		return
	}

	let root = resolve(process.cwd())
	for (let fileName of ['.env.test', '.env']) {
		let filePath = resolve(root, fileName)
		if (!existsSync(filePath)) {
			continue
		}

		let lines = readFileSync(filePath, 'utf8').split(/\r?\n/u)
		for (let line of lines) {
			let parsed = parseEnvLine(line)
			if (!parsed) {
				continue
			}

			let [key, value] = parsed
			if (!(key in process.env)) {
				process.env[key] = value
			}
		}
	}

	envLoaded = true
}
