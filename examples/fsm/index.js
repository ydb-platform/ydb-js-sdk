import { createMachineRuntime } from '@ydbjs/fsm'

let initialState = 'idle'

let initialContext = {
	count: 0,
}

let effects = {
	'counter.log'(effect) {
		console.log('[effect]', effect.message)
	},
}

function transition(context, state, event, runtime) {
	switch (event.type) {
		case 'counter.start':
			runtime.emit({ type: 'counter.state', value: 'running' })
			return {
				state: 'running',
				effects: [{ type: 'counter.log', message: 'counter started' }],
			}

		case 'counter.increment':
			if (state !== 'running') {
				return
			}

			context.count += event.step ?? 1
			runtime.emit({ type: 'counter.value', value: context.count })

			return {
				effects: [
					{
						type: 'counter.log',
						message: `incremented to ${context.count}`,
					},
				],
			}

		case 'counter.finish':
			runtime.emit({ type: 'counter.state', value: 'done' })
			return {
				state: 'done',
				effects: [{ type: 'counter.log', message: `counter finished at ${context.count}` }],
			}

		default:
			return
	}
}

async function main() {
	let runtime = createMachineRuntime({
		initialState,
		context: initialContext,
		transition,
		effects,
	})

	let done = Promise.withResolvers()

	let outputsTask = (async () => {
		for await (let output of runtime) {
			switch (output.type) {
				case 'counter.state':
					console.log('[output state]', output.value)
					if (output.value === 'done') {
						done.resolve()
					}
					break
				case 'counter.value':
					console.log('[output value]', output.value)
					break
				default:
					break
			}
		}
	})()

	runtime.dispatch({ type: 'counter.start' })
	runtime.dispatch({ type: 'counter.increment' })
	runtime.dispatch({ type: 'counter.increment', step: 2 })
	runtime.dispatch({ type: 'counter.increment', step: 3 })
	runtime.dispatch({ type: 'counter.finish' })

	await done.promise
	await runtime.close('example completed')
	await outputsTask
}

void main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
