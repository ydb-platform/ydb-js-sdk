import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { abortable } from '@ydbjs/abortable'

export type FaultScenario =
	| { type: 'reset'; code: number; streaming: boolean }
	| { type: 'terminal-reset'; status: number; code: number }
	| { type: 'receive-tail'; fault: 'malformed' | 'truncated' | 'gzip' }
	| { type: 'backpressure'; initialWindowSize: 0 | 65535 }
	| {
			type:
				| 'missing-status'
				| 'premature-close'
				| 'partial-body'
				| 'flow-control'
				| 'keepalive'
				| 'keepalive-cap'
	  }

type Snapshot = {
	sessions: number
	streams: number
	consumedRequestBytes: number
	bufferedRequestBytes: number
	requestMessages: number
	requestResetCodes: number[]
	attemptedResets: number[]
	observations: { name: string; value: unknown; at: number }[]
	pings: number
	pingDelays: number[]
	errors: string[]
}

type Deferred = ReturnType<typeof Promise.withResolvers<unknown>>

export async function nodePeer(scenario: FaultScenario, signal: AbortSignal) {
	let executable = process.env.GRPC_TEST_NODE
	if (!executable) {
		if (process.versions.bun) {
			throw new Error(
				'Set GRPC_TEST_NODE to a Node executable to run HTTP/2 fault tests under Bun'
			)
		}
		executable = process.execPath
	}
	let env = { ...process.env }
	delete env.NODE_OPTIONS
	let child = spawn(
		executable,
		[fileURLToPath(new URL('./node-peer.mjs', import.meta.url)), JSON.stringify(scenario)],
		{
			stdio: ['pipe', 'pipe', 'pipe'],
			env,
		}
	)
	let output = createInterface({ input: child.stdout })
	let ready = Promise.withResolvers<{ authority: string; node: string; executable: string }>()
	let closed = Promise.withResolvers<void>()
	let failed = Promise.withResolvers<never>()
	let events = new Map<string, Deferred>()
	let responses = new Map<number, Deferred>()
	let sequence = 0
	let disposing = false
	let failure: Error | undefined
	void failed.promise.catch(() => {})

	function fail(error: Error): void {
		failure ??= error
		failed.reject(failure)
	}

	function event(name: string): Deferred {
		let pending = events.get(name)
		if (!pending) {
			pending = Promise.withResolvers<unknown>()
			events.set(name, pending)
		}
		return pending
	}

	function wait<T>(promise: Promise<T>, waitingSignal = signal): Promise<T> {
		return abortable(waitingSignal, Promise.race([promise, failed.promise]))
	}

	async function request<T>(command: string, waitingSignal = signal): Promise<T> {
		let id = ++sequence
		let pending = Promise.withResolvers<unknown>()
		responses.set(id, pending)
		child.stdin.write(JSON.stringify({ id, command }) + '\n')
		return (await wait(pending.promise, waitingSignal)) as T
	}

	output.on('line', (line) => {
		try {
			let record = JSON.parse(line)
			if (record.type === 'ready') {
				if (typeof record.node !== 'string' || !record.node) {
					throw new Error('Fault peer did not report a Node runtime')
				}
				ready.resolve(record)
			} else if (record.type === 'event') {
				event(record.name).resolve(record.value)
			} else if (record.type === 'response') {
				let pending = responses.get(record.id)
				responses.delete(record.id)
				pending?.resolve(record.value)
			} else {
				throw new Error('Unexpected fault-peer output')
			}
		} catch (error) {
			fail(error as Error)
		}
	})
	child.on('error', fail)
	child.stdin.on('error', fail)
	child.stderr.on('data', (chunk) => fail(new Error(`Node fault peer stderr: ${chunk}`)))
	child.once('close', (code, exitSignal) => {
		if (!disposing || code !== 0 || exitSignal) {
			fail(new Error(`Node fault peer exited with code ${code}, signal ${exitSignal}`))
		}
		closed.resolve()
	})

	async function dispose(): Promise<void> {
		if (disposing) {
			return
		}
		disposing = true
		let cleanup = AbortSignal.timeout(1000)
		try {
			if (child.exitCode === null && child.signalCode === null) {
				await request('stop', cleanup)
			}
			await abortable(cleanup, closed.promise)
		} catch (error) {
			child.kill('SIGKILL')
			await closed.promise
			throw failure ?? error
		} finally {
			output.close()
		}
		if (failure) {
			throw failure
		}
	}

	try {
		let started = await wait(ready.promise)
		return {
			...started,
			wait: (name: string) => wait(event(name).promise),
			command: (name: string) => request<void>(name),
			snapshot: () => request<Snapshot>('snapshot'),
			[Symbol.asyncDispose]: dispose,
		}
	} catch (error) {
		child.kill('SIGKILL')
		await closed.promise
		output.close()
		throw error
	}
}
