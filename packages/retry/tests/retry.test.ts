import * as assert from "node:assert";
import test from "node:test";

import { retry } from "@ydbjs/retry";

let isError = (error: unknown) => error instanceof Error

test("retry", async (tc) => {
	await tc.test("do retry", async () => {
		let attempts = 0

		await retry({ retry: isError }, async () => {
			if (attempts > 2) {
				return
			}

			attempts++
			throw new Error("DO_RETRY")
		})

		assert.strictEqual(attempts, 3)
	})

	await tc.test("budget exhausted", async () => {
		let attempts = 0

		let result = retry({ retry: isError, budget: 0 }, async () => {
			if (attempts > 2) {
				return
			}

			attempts++
			throw new Error("DO_NOT_RETRY")
		})

		await assert.rejects(result)
	})

	await tc.test("retry with signal", async () => {
		let attempts = 0
		let controller = new AbortController()

		let result = retry({ retry: isError, signal: controller.signal }, async () => {
			if (attempts > 2) {
				return
			}

			attempts++
			throw new Error("DO_RETRY")
		})

		controller.abort()

		await assert.rejects(result)
	})
})
