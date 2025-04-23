// eslint-disable no-await-in-loop
import type { TestProject } from 'vitest/node'
import { $ } from 'zx'

declare module 'vitest' {
	export interface ProvidedContext {
		connectionString: string
		credentialsUsername: string
		credentialsPassword: string
		credentialsEndpoint: string
	}
}

let configured = false

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

	await $`docker run --rm --detach --publish 2135 --publish 2136 --publish 8765 --publish 9092 --hostname localhost --platform linux/amd64 --name ydb ydbplatform/local-ydb:25.1.1.3`

	let signal = AbortSignal.timeout(30 * 1000)
	while ((await $`docker inspect -f {{.State.Health.Status}} ydb`.text()).trim() !== 'healthy') {
		signal.throwIfAborted()
		await $`sleep 1`
	}

	let [ipv4, _ipv6] = await $`docker port ydb 2136/tcp`.lines()

	project.provide('connectionString', `grpc://${ipv4}/local`)
	project.provide('credentialsUsername', 'root')
	project.provide('credentialsPassword', '1234')
	project.provide('credentialsEndpoint', `grpc://${ipv4}`)

	configured = true
}

/**
 * Tears down the YDB Docker container if it has been configured.
 *
 * This function checks if the YDB environment has been configured.
 * If configured, it removes the YDB Docker container forcefully.
 */
export async function teardown() {
	if (!configured) {
		return
	}

	await $`docker rm -f ydb`
}
