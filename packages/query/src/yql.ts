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
		values.forEach((value, i) => {
			if (value[SymbolUnsafe]) {
				return
			}

			let ydbValue = isObject(value) && 'type' in value && 'kind' in value['type'] ? value : fromJs(value)

			params[`$p${i}`] = ydbValue
		})
	}

	if (typeof strings === 'string') {
		text += strings
	}

	if (Array.isArray(strings)) {
		text += strings.reduce((prev, curr, i) => {
			let value = values[i]

			return prev + curr + (value ? value[SymbolUnsafe] ? value.toString() : `$p${i}` : '')
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
