// eslint-disable no-await-in-loop
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import type { TestProject } from 'vitest/node'

let executeFile = promisify(execFile)
async function docker(...args: string[]): Promise<string> {
	let { stdout } = await executeFile('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
	return stdout.trim()
}

declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
		credentialsUsername: string
		credentialsPassword: string
		credentialsEndpoint: string
	}
}

let containerID: string | null = null

/**
 * Find a free TCP port on localhost.
 */
function findFreePort(): Promise<number> {
	let { promise, resolve, reject } = Promise.withResolvers<number>()
	let server = createServer()
	server.on('error', reject)

	server.listen(0, '127.0.0.1', () => {
		let port = (server.address() as AddressInfo).port
		server.close(() => resolve(port))
	})

	return promise
}

/**
 * Sets up the test project by providing necessary environment variables for YDB connection.
 * If the YDB_CONNECTION_STRING environment variable is set, it uses the provided credentials.
 * Otherwise, it starts a local YDB Docker container, waits for it to become healthy, and then provides
 * the connection details.
 *
 * @param project - The test project to configure with YDB connection details.
 */
export async function setup(project: TestProject) {
	if (process.env['YDB_CONNECTION_STRING']) {
		project.provide('connectionString', process.env['YDB_CONNECTION_STRING'])
		project.provide('credentialsUsername', process.env['YDB_STATIC_CREDENTIALS_USER']!)
		project.provide('credentialsPassword', process.env['YDB_STATIC_CREDENTIALS_PASSWORD']!)
		project.provide('credentialsEndpoint', process.env['YDB_STATIC_CREDENTIALS_ENDPOINT']!)

		return
	}

	// Allocate random ports so that discovery returns addresses that are
	// accessible from the host.  We pass the same port as both the host-side
	// and container-side value (--publish P:P) and configure the YDB node to
	// listen on that port via GRPC_PORT / MON_PORT env vars.  This way
	// discovery returns "localhost:P" which matches the host-accessible port.
	let monPort = await findFreePort()
	let grpcPort = await findFreePort()

	let limits: string[] = []
	let memory = process.env['YDB_TEST_DOCKER_MEMORY']
	let cpus = process.env['YDB_TEST_DOCKER_CPUS']
	if (memory) limits.push('--memory', memory, '--memory-swap', memory)
	if (cpus) limits.push('--cpus', cpus)
	if (process.env['YDB_TEST_RUN_ID'])
		limits.push('--label', `ydbjs.verification=${process.env['YDB_TEST_RUN_ID']}`)
	containerID = await docker(
		'run',
		'--rm',
		'--detach',
		'--hostname',
		'localhost',
		'--platform',
		'linux/amd64',
		'--publish',
		`127.0.0.1:${monPort}:${monPort}`,
		'--publish',
		`127.0.0.1:${grpcPort}:${grpcPort}`,
		'--env',
		`MON_PORT=${monPort}`,
		'--env',
		`GRPC_PORT=${grpcPort}`,
		...limits,
		'ydbplatform/local-ydb:25.3'
	)

	// Ensure the container is removed when the process is interrupted (Ctrl-C)
	// or terminated, not just when vitest calls teardown() normally.
	for (let sig of ['SIGINT', 'SIGTERM'] as const) {
		process.once(sig, async () => {
			await teardown()
			process.exit(sig === 'SIGINT' ? 130 : 143)
		})
	}

	try {
		let signal = AbortSignal.timeout(30 * 1000)
		while (
			(await docker('inspect', '-f', '{{.State.Health.Status}}', containerID)) !== 'healthy'
		) {
			signal.throwIfAborted()
			await setTimeout(1000, undefined, { signal })
		}
	} catch (error) {
		await teardown()
		throw error
	}

	project.provide('connectionString', `grpc://localhost:${grpcPort}/local`)
	project.provide('credentialsUsername', 'root')
	project.provide('credentialsPassword', '1234')
	project.provide('credentialsEndpoint', `grpc://localhost:${grpcPort}`)
}

export async function teardown() {
	if (!containerID) {
		return
	}

	let id = containerID
	containerID = null
	await docker('rm', '-f', id)
}
