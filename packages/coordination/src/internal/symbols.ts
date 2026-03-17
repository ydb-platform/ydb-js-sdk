import type { SessionRuntime } from '../runtime/session-runtime.js'

export let sessionRuntimeSymbol = Symbol('CoordinationSessionRuntime')

export type CoordinationSessionInternal = {
	[sessionRuntimeSymbol]: SessionRuntime
}
