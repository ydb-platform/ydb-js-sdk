import { fromJs, type Value } from "@ydbjs/value"

const unsafe = Symbol("unsafe")

function isObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class UnsafeString extends String {
	constructor(public value: string) {
		super(value)
	}

	[unsafe] = true
}

export function yql<P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
): { text: string, params: Record<string, Value> } {
	let text = ''
	let params: Record<string, Value> = Object.assign({}, null)

	if (Array.isArray(values)) {
		values.forEach((value, i) => {
			if (value[unsafe]) {
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

			return prev + curr + (value ? value[unsafe] ? value.toString() : `$p${i}` : '')
		}, '')
	}

	return { text, params }
}

export function usafe(value: string | { toString(): string }) {
	return new UnsafeString(value.toString())
}

export function table(path: string) {
	return usafe("`" + path + "`")
}
