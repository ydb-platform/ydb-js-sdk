import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let previews = process.env.PREVIEW_PACKAGES.split(' ')
let directory = mkdtempSync(join(tmpdir(), 'ydbjs-preview-'))

try {
	for (let [example, entry] of [
		['query-clients', 'src/demo.ts'],
		['drizzle-adapter', 'index.js'],
	]) {
		let cwd = join(directory, example)
		cpSync(join('examples', example), cwd, { recursive: true })

		let { dependencies } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
		let packages = []
		for (let name of Object.keys(dependencies)) {
			if (name.startsWith('@ydbjs/')) {
				let preview = previews.find((locator) => locator.startsWith(name + '@'))
				if (!preview) {
					throw new Error(`Missing preview for ${name} in ${example}`)
				}
				packages.push(preview)
			}
		}

		execFileSync('npm', ['install', '--no-audit', '--no-fund', ...packages], {
			cwd,
			stdio: 'inherit',
		})
		let lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
		for (let [path, dependency] of Object.entries(lock.packages)) {
			if (path.includes('node_modules/@ydbjs/')) {
				assert.equal(dependency.version, process.env.PREVIEW_VERSION, path)
			}
		}
		execFileSync(process.execPath, [entry], { cwd, stdio: 'inherit' })
	}
} finally {
	rmSync(directory, { recursive: true, force: true })
}
