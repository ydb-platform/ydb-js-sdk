#!/usr/bin/env bun
// Build SLO entries into a flat `dist/` via Bun.build.
//
// Layout:
//   index.ts                    → dist/index.js            (supervisor)
//   workloads/<wl>/<wl>.<phase>.ts  → dist/<wl>.<phase>.js (worker)
//
// `splitting: false` is critical — each entry must be a self-contained
// bundle, otherwise `new Worker(new URL('./kv.read.js', ...))` can't load
// its runtime dependencies at process spawn time.

import { Glob } from 'bun'
import path from 'node:path'

let slo = path.resolve(import.meta.dir, '..')

let entrypoints: string[] = [path.join(slo, 'index.ts')]
for await (let file of new Glob('workloads/*/*.ts').scan({ cwd: slo })) {
	entrypoints.push(path.join(slo, file))
}

console.log('building %d entries → dist/', entrypoints.length)

let result = await Bun.build({
	entrypoints,
	outdir: path.join(slo, 'dist'),
	target: 'node',
	format: 'esm',
	splitting: false,
	naming: { entry: '[name].js' },
	sourcemap: 'linked',
})

if (!result.success) {
	for (let msg of result.logs) console.error(msg)
	process.exit(1)
}

for (let out of result.outputs) {
	console.log('  ✓', path.relative(slo, out.path))
}
