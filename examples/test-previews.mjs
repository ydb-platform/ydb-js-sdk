import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let previews = process.env.PREVIEW_PACKAGES.split(' ')

for (let manifest of globSync('*/package.json', { cwd: import.meta.dirname }).sort()) {
	let cwd = join(import.meta.dirname, dirname(manifest))
	let { dependencies, scripts } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
	let sdk = Object.keys(dependencies ?? {}).filter((name) => name.startsWith('@ydbjs/'))
	let packages = sdk.map((name) => {
		let preview = previews.find((locator) => locator.startsWith(name + '@'))
		assert.ok(preview, `Missing preview for ${name} in ${manifest}`)
		return preview
	})

	let npm = ['--prefix', cwd, '--workspaces=false']
	execFileSync('npm', [...npm, 'install', '--no-save', '--no-audit', '--no-fund', ...packages], {
		stdio: 'inherit',
	})
	let lock = JSON.parse(readFileSync(join(cwd, 'node_modules/.package-lock.json'), 'utf8'))
	for (let [path, pkg] of Object.entries(lock.packages)) {
		let name = path.split('node_modules/').at(-1)
		if (name.startsWith('@ydbjs/')) {
			assert.equal(pkg.version, process.env.PREVIEW_VERSION, path)
			assert.ok(previews.includes(name + '@' + pkg.resolved), `Unexpected URL for ${path}`)
		}
	}
	execFileSync('npm', [...npm, scripts.test ? 'test' : 'start'], { stdio: 'inherit' })
}
