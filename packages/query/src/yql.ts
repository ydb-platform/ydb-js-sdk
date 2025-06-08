import { type Value, fromJs } from "@ydbjs/value"

const SymbolUnsafe = Symbol("unsafe")

function isObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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

	if (Array.isArray(values)) {
		let skip: number = 0
		values.forEach((value, i) => {
			if (value === undefined || value === null) {
				throw new Error(`Undefined or null value passed to yql. For null use YDB Optional type.`);
			}

			if (value[SymbolUnsafe]) {
				skip += 1
				return
			}

			let ydbValue = isObject(value) && 'type' in value && 'kind' in value['type'] ? value : fromJs(value)

			params[`$p${i - skip}`] = ydbValue
		})
	}

	if (typeof strings === 'string') {
		text += strings
	}

	if (Array.isArray(strings)) {
		let skip: number = 0
		text += strings.reduce((prev, curr, i) => {
			let value = values[i]
			if (value === undefined || value === null) {
				return prev + curr
			}

			if (value[SymbolUnsafe]) {
				skip += 1
			}

			return prev + curr + (value[SymbolUnsafe] ? value.toString() : `$p${i - skip}`)
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
