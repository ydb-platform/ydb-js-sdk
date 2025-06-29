import { type Value, fromJs } from "@ydbjs/value"

const SymbolUnsafe = Symbol("unsafe")

function isObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Enhanced validation with detailed error messages for better debugging
function validateValue(value: unknown, index: number): void {
	if (value === undefined) {
		throw new Error(
			`❌ Undefined value at position ${index} in yql template. ` +
			`This usually means:\n` +
			`  • A variable wasn't initialized\n` +
			`  • A function returned undefined\n` +
			`  • An object property doesn't exist\n` +
			`For intentional null database values, use YDB Optional type.`
		)
	}

	if (value === null) {
		throw new Error(
			`❌ Null value at position ${index} in yql template. ` +
			`JavaScript null is not directly supported in YDB queries.\n` +
			`For null database values, use YDB Optional type instead.`
		)
	}
}

export class UnsafeString extends String {
	[SymbolUnsafe] = true
}

export function yql<P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
): { text: string, params: Record<string, Value> } {
	let text = ''
	let params: Record<string, Value> = Object.assign({}, null)

	// Handle simple string case
	if (typeof strings === 'string') {
		return { text: strings, params }
	}

	// Handle template literal case
	if (Array.isArray(strings)) {
		let skipCount = 0

		// Process parameters first to build params object and count skipped values
		values.forEach((value, i) => {
			// Enhanced validation with position info
			validateValue(value, i)

			if ((value as any)[SymbolUnsafe]) {
				skipCount++
				return
			}

			let ydbValue = isObject(value) && 'type' in value && 'kind' in (value as any)['type'] ? value as Value : fromJs(value as any)
			params[`$p${i - skipCount}`] = ydbValue
		})

		// Build text with proper parameter references
		skipCount = 0
		text = strings.reduce((prev, curr, i) => {
			let value = values[i]

			// This should never happen due to validation above, but keep for safety
			if (value === undefined || value === null) {
				return prev + curr
			}

			if ((value as any)[SymbolUnsafe]) {
				skipCount++
				return prev + curr + value.toString()
			}

			return prev + curr + `$p${i - skipCount}`
		}, '')
	}

	return { text, params }
}

export function unsafe(value: string | { toString(): string }) {
	return new UnsafeString(value.toString())
}

export function identifier(path: string) {
	return unsafe("`" + path + "`")
}
