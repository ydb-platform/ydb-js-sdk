import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { type TestContext, expect, test } from 'vitest'

let execute = promisify(execFile)
let source = fileURLToPath(new URL('./topic-chaos.py', import.meta.url))

// Inspect planning and identity checks without running Docker or injecting faults.
let python = async function python(context: TestContext, body: string): Promise<unknown> {
	let { stdout } = await execute(
		'python3',
		[
			'-B',
			'-c',
			`import importlib.util, json, sys, argparse
spec = importlib.util.spec_from_file_location('chaos', sys.argv[1])
chaos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chaos)
${body}`,
			source,
		],
		{ signal: context.signal }
	)
	return JSON.parse(stdout)
}

test('keeps the six controlled faults scoped to frozen database IDs', async (tc) => {
	let plan = await python(
		tc,
		`print(json.dumps(chaos.fault_plan({'container_ids': {'database-1': 'a', 'database-2': 'b'}})))`
	)
	expect(plan).toEqual([
		{
			at_seconds: 60,
			fault: 'kill',
			target: 'database-1',
			target_id: 'a',
			duration_seconds: 0,
		},
		{
			at_seconds: 180,
			fault: 'pause',
			target: 'database-2',
			target_id: 'b',
			duration_seconds: 20,
		},
		{
			at_seconds: 300,
			fault: 'drop',
			target: 'database-2',
			target_id: 'b',
			duration_seconds: 30,
		},
		{
			at_seconds: 450,
			fault: 'kill',
			target: 'database-2',
			target_id: 'b',
			duration_seconds: 0,
		},
		{
			at_seconds: 600,
			fault: 'pause',
			target: 'database-1',
			target_id: 'a',
			duration_seconds: 25,
		},
		{
			at_seconds: 720,
			fault: 'drop',
			target: 'database-2',
			target_id: 'b',
			duration_seconds: 30,
		},
	])
})

test('derives IDs and addresses from read-only compose lookups', async (tc) => {
	let resolved = await python(
		tc,
		`names = ['database-1', 'database-2', 'storage-1', 'prometheus']
ids = {name: str(i + 1) * 64 for i, name in enumerate(names)}
nodes = {ids[name]: {'Id': ids[name], 'Image': 'image',
    'Config': {'Labels': {'com.docker.compose.project': 'test-project', 'com.docker.compose.service': name}},
    'NetworkSettings': {'Networks': {'test-network': {'IPAddress': '10.9.0.' + str(i + 10)}},
                        'Ports': {'9090/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '19090'}]}}}
    for i, name in enumerate(names)}
commands = []
def output(command, **_options):
    commands.append(command)
    if 'ps' in command:
        return ids[command[-1]] + '\\n'
    if 'image' in command:
        return json.dumps([{'Id': 'image', 'Architecture': 'amd64', 'Os': 'linux'}])
    if 'inspect' in command:
        return json.dumps([nodes[command[-1]]])
    if 'config' in command:
        return json.dumps({'services': {}})
    raise AssertionError('Unexpected Docker command: ' + str(command))
chaos.subprocess.check_output = output
args = argparse.Namespace(context='test-context', project='test-project', compose_file='compose.json', network='test-network')
result = chaos.infrastructure(args)
print(json.dumps({'ips': result['ips'], 'ids': result['container_ids'], 'url': result['prometheus_url'], 'commands': commands}))`
	)
	expect(resolved).toMatchObject({
		ips: { 'database-1': '10.9.0.10', 'database-2': '10.9.0.11' },
		ids: { 'database-1': '1'.repeat(64), 'database-2': '2'.repeat(64) },
		url: 'http://127.0.0.1:19090',
	})
	for (let command of (resolved as { commands: string[][] }).commands) {
		expect(command.slice(0, 3)).toEqual(['docker', '--context', 'test-context'])
		expect(
			command.some((argument) =>
				['kill', 'pause', 'unpause', 'exec', 'start'].includes(argument)
			)
		).toBe(false)
	}
})

test('rejects a node from another project or network before fault injection', async (tc) => {
	let errors = await python(
		tc,
		`node = {'Config': {'Labels': {'com.docker.compose.project': 'owned', 'com.docker.compose.service': 'database-1'}},
        'NetworkSettings': {'Networks': {'owned-net': {'IPAddress': '10.1.0.11'}}}}
errors = []
for project, network in [('other', 'owned-net'), ('owned', 'other-net')]:
    try:
        chaos.validate_node(node, 'database-1', project, network)
    except RuntimeError as error:
        errors.append(str(error))
print(json.dumps(errors))`
	)
	expect(errors).toEqual([
		'Target identity mismatch: database-1',
		'database-1 is outside the requested network',
	])
})

test('redacts credentials from container and compose artifacts', async (tc) => {
	let artifacts = await python(
		tc,
		`env = {'WORKLOAD_REF': 'revision', 'WORKLOAD_DURATION': '900', 'YDB_ACCESS_TOKEN': 'secret-token',
       'YDB_CONNECTION_STRING': 'grpcs://user:secret-password@database:2135/local?token=secret-query'}
node = {'Id': 'id', 'Name': '/workload', 'Image': 'image', 'State': {'Running': True}, 'RestartCount': 0,
        'Config': {'Env': [key + '=' + value for key, value in env.items()], 'Labels': {}},
        'HostConfig': {'Memory': 4096}, 'NetworkSettings': {'Networks': {}}}
document = {'services': {'workload': {'environment': env, 'command': ['--token', 'secret-command'],
    'entrypoint': 'secret-entrypoint', 'build': {'args': {'TOKEN': 'secret-build'}},
    'healthcheck': {'test': ['CMD', 'secret-check']}}}, 'secrets': {'inline': {'content': 'secret-content'}}}
print(json.dumps({'container': chaos.snapshot(node), 'compose': chaos.redact_compose(document)}))`
	)
	expect(artifacts).toMatchObject({
		container: { Environment: { WORKLOAD_REF: 'revision', WORKLOAD_DURATION: '900' } },
		compose: { services: { workload: { environment: { YDB_ACCESS_TOKEN: '[redacted]' } } } },
	})
	expect(JSON.stringify(artifacts)).not.toContain('secret-')
})
