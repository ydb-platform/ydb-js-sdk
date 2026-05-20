function collectIssueMessages(value: unknown, messages: string[]): void {
	if (!value) {
		return
	}

	if (Array.isArray(value)) {
		for (let item of value) {
			collectIssueMessages(item, messages)
		}

		return
	}

	if (typeof value !== 'object') {
		return
	}

	let issue = value as { message?: unknown; issues?: unknown }
	if (typeof issue.message === 'string') {
		messages.push(issue.message)
	}

	collectIssueMessages(issue.issues, messages)
}

export function getErrorDetails(error: unknown): string {
	let messages: string[] = []

	if (error instanceof Error) {
		messages.push(error.message)
	} else {
		messages.push(String(error))
	}

	if (error && typeof error === 'object' && 'issues' in error) {
		collectIssueMessages((error as { issues?: unknown }).issues, messages)
	}

	return messages.join('\n')
}

export async function ignoreMissingObject(action: () => Promise<unknown>): Promise<void> {
	try {
		await action()
	} catch (error) {
		let message = getErrorDetails(error)
		if (!/(not found|not exist|does not exist|missing|no such|path)/iu.test(message)) {
			throw error
		}
	}
}

export async function ignoreUnsupportedYqlFeature(
	feature: string,
	action: () => Promise<unknown>
): Promise<boolean> {
	try {
		await action()
		return false
	} catch (error) {
		let message = getErrorDetails(error)
		if (
			/(not supported|unsupported|pre type annotation|type annotation|expression evaluation|precondition_failed|generic_error|batch operations are not supported|unqualified alter table request)/iu.test(
				message
			)
		) {
			if (process.env['YDB_TEST_VERBOSE'] === '1') {
				console.log(`[test] Skipping optional live check: ${feature}`)
			}

			return true
		}

		throw error
	}
}
