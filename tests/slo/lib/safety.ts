type OnError = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown) => void

let installed = false
export function installSafetyHandlers(mode: 'log' | 'exit' = 'exit', onError?: OnError): void {
	if (installed) return
	installed = true

	let handle = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown) => {
		console.error(`[safety] ${kind}:`, err)

		try {
			onError?.(kind, err)
		} catch (hookErr) {
			console.error('[safety] onError hook threw:', hookErr)
		}

		if (mode === 'exit') {
			setTimeout(() => process.exit(1), 50).unref()
		}
	}

	process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason))
	process.on('uncaughtException', (err) => handle('uncaughtException', err))
}
