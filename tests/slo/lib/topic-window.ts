import { abortable } from '@ydbjs/abortable'

export class TopicWindow {
	#committed = 0
	#progress = Promise.withResolvers<void>()

	constructor(readonly limit: number) {}

	commit(count: number): void {
		if (!Number.isSafeInteger(count) || count < this.#committed) {
			throw new Error('Invalid committed message count')
		}

		if (count === this.#committed) {
			return
		}

		this.#committed = count
		this.#progress.resolve()
		this.#progress = Promise.withResolvers<void>()
	}

	async wait(accepted: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()

		while (accepted - this.#committed >= this.limit) {
			// oxlint-disable-next-line no-await-in-loop
			await abortable(signal, this.#progress.promise)
		}
	}
}
