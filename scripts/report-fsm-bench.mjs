import { readFile } from 'node:fs/promises'

let report = JSON.parse(await readFile(process.argv[2], 'utf8'))
let rows = report.files.flatMap((file) => file.groups.flatMap((group) => group.benchmarks))
if (rows.length === 0) throw new Error('No FSM benchmark measurements')

let scenarios = [
	'raw transition',
	'idle dispatch',
	'blocked burst drain',
	'sync effect',
	'resolved Promise effect',
	'emit and consume',
	'ingest and map',
	'queue buffered take',
	'queue one parked take',
	'queue mass parked takes',
]
let groups = new Map()
let lines = [
	'## FSM scaling',
	'',
	`Runtime: ${process.version}, ${process.platform}/${process.arch}.`,
	'',
	'Wall time includes one complete burst, creation and disposal. These are not CPU, GC or SDK throughput measurements.',
	'Absolute timing is informational on shared runners; correctness and resource-budget tests are separate CI gates.',
	'',
	'| Scenario | Items | Mean ms/burst | ns/item | RME | Samples |',
	'| --- | ---: | ---: | ---: | ---: | ---: |',
]
for (let row of rows) {
	let match = /^(.*) \/ (\d+) (?:events|items|waiters) per burst$/.exec(row.name)
	if (
		!match ||
		!Number.isFinite(row.mean) ||
		row.mean <= 0 ||
		!Number.isFinite(row.rme) ||
		row.rme < 0 ||
		row.error !== undefined ||
		!Number.isInteger(row.sampleCount) ||
		row.sampleCount < 3
	) {
		throw new Error(`Incomplete FSM benchmark: ${row.name}`)
	}
	let [, name, count] = match
	let size = Number(count)
	if (![128, 4000, 64000].includes(size)) throw new Error(`Unexpected FSM size: ${row.name}`)
	let perItem = (row.mean * 1e6) / size
	let sizes = groups.get(name) ?? new Map()
	if (sizes.has(size)) throw new Error(`Duplicate FSM benchmark: ${row.name}`)
	sizes.set(size, perItem)
	groups.set(name, sizes)
	lines.push(
		`| ${name} | ${size} | ${row.mean.toFixed(4)} | ${perItem.toFixed(1)} | ±${row.rme.toFixed(1)}% | ${row.sampleCount} |`
	)
}
for (let [name, sizes] of groups) {
	if ([128, 4000, 64000].some((size) => !sizes.has(size))) {
		throw new Error(`Missing FSM scaling size: ${name}`)
	}
}

if (groups.size !== scenarios.length || scenarios.some((name) => !groups.has(name))) {
	throw new Error('Missing or unexpected FSM benchmark scenarios')
}

lines.push('', '| Scenario | Per-item cost, 64000 / 4000 |', '| --- | ---: |')
for (let [name, sizes] of groups) {
	let ratio = sizes.get(64000) / sizes.get(4000)
	lines.push(`| ${name} | ${ratio.toFixed(2)}× |`)
}
lines.push(
	'',
	'The mass-waiter scenario is an exported-queue fanout stress test, not the SDK single-consumer path.'
)

let drain = groups.get('blocked burst drain')
if (!drain) throw new Error('Missing blocked-burst scaling measurements')
let growth = drain.get(64000) / drain.get(4000)
lines.push('', `Blocked-burst cost per event, 64000 / 4000: **${growth.toFixed(2)}×**.`, '')
// A wide warning budget exposes the large-queue shift cliff without making shared-host timing a unit-test gate.
if (growth > 4) {
	lines.push(
		'Investigate superlinear drain cost: per-event time grew more than 4× for a 16× larger burst.'
	)
	process.stderr.write(
		`::warning title=FSM scaling::Blocked drain cost per event grew ${growth.toFixed(2)}x between 4000 and 64000 events. Inspect the raw benchmark artifact.\n`
	)
}
process.stdout.write(`${lines.join('\n')}\n`)
