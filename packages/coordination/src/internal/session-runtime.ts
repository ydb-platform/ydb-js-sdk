import type { SessionRuntime } from '../runtime/session-runtime.js'
import type { CoordinationSession } from '../session.js'
import { type CoordinationSessionInternal, sessionRuntimeSymbol } from './symbols.js'

export let getSessionRuntime = function getSessionRuntime(
	session: CoordinationSession
): SessionRuntime {
	return (session as CoordinationSessionInternal)[sessionRuntimeSymbol]!
}
