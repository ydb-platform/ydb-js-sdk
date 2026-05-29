import { type Value, fromJs } from '@ydbjs/value'

// ──────────────────────────────────────────────────────────────────────────
// Internal markers
// ──────────────────────────────────────────────────────────────────────────

const SymbolUnsafe = Symbol('unsafe')
const SymbolFragment = Symbol('fragment')

// ──────────────────────────────────────────────────────────────────────────
// Value helpers
// ──────────────────────────────────────────────────────────────────────────

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

function toYdbValue(value: any): Value {
	return isObject(value) && 'type' in value && 'kind' in (value as any)['type']
		? (value as Value)
		: fromJs(value as any)
}

// ──────────────────────────────────────────────────────────────────────────
// Raw SQL: identifiers and unsafe injection
// ──────────────────────────────────────────────────────────────────────────

export class UnsafeString extends String {
	[SymbolUnsafe] = true
}

export function unsafe(value: string | { toString(): string }) {
	return new UnsafeString(value.toString())
}

export function identifier(path: string) {
	// Escape backticks inside identifier by doubling them
	// Example: my`table -> my``table
	let escaped = path.replaceAll('`', '``')
	return unsafe('`' + escaped + '`')
}

// ──────────────────────────────────────────────────────────────────────────
// Composable fragments
// ──────────────────────────────────────────────────────────────────────────

/**
 * A composable, non-executable piece of a query: its own template text plus
 * bound values, which may themselves be other fragments, `UnsafeString`s, or
 * scalars. Parameter names are assigned only when the fragment is flattened
 * into a query, so fragments nest without parameter-name collisions.
 *
 * Create with {@link fragment} or {@link join}; splice into a `yql`/`fragment`
 * template like any other interpolated value.
 */
export class Fragment {
	[SymbolFragment] = true

	constructor(
		readonly strings: readonly string[],
		readonly values: readonly unknown[]
	) {}
}

function isFragment(value: unknown): value is Fragment {
	return isObject(value) && (value as any)[SymbolFragment] === true
}

/**
 * Create a composable query {@link Fragment} from a tagged template. Unlike the
 * query client's `sql\`\``, a fragment is not executable — it only nests into
 * another `yql`/`fragment` template or {@link join}.
 *
 * @example ```ts
 * const cond = fragment`${identifier('age')} > ${18}`
 * sql`SELECT * FROM users WHERE ${cond}`
 * ```
 */
export function fragment<P extends any[] = unknown[]>(
	strings: TemplateStringsArray,
	...values: P
): Fragment {
	return new Fragment(strings as readonly string[], values)
}

/**
 * Combine fragments into one, interleaving a separator between them. An empty
 * list yields an empty fragment; a single fragment is returned without a
 * separator. The separator is structural SQL — a string is inserted as raw text.
 *
 * @example ```ts
 * const where = join(conditions, ' AND ')
 * sql`SELECT * FROM users WHERE ${where}`
 * ```
 */
export function join(fragments: readonly Fragment[], separator: Fragment | string = ''): Fragment {
	let sep = typeof separator === 'string' ? unsafe(separator) : separator
	let values: unknown[] = []
	for (let i = 0; i < fragments.length; i++) {
		if (i > 0) values.push(sep)
		values.push(fragments[i])
	}

	return new Fragment(new Array(values.length + 1).fill(''), values)
}

// ──────────────────────────────────────────────────────────────────────────
// Query building
// ──────────────────────────────────────────────────────────────────────────

// Single recursive pass over the template tree. A shared counter assigns
// `$p0..$pN` in traversal order across nested fragments — no renumbering.
function flatten(
	strings: readonly string[],
	values: readonly unknown[],
	params: Record<string, Value>,
	counter: { n: number }
): string {
	let text = ''
	for (let i = 0; i < strings.length; i++) {
		text += strings[i]
		if (i >= values.length) continue

		let value = values[i]
		validateValue(value, i)

		if ((value as any)[SymbolUnsafe]) {
			text += (value as UnsafeString).toString()
		} else if (isFragment(value)) {
			text += flatten(value.strings, value.values, params, counter)
		} else {
			let name = `$p${counter.n}`
			params[name] = toYdbValue(value)
			text += name
			counter.n++
		}
	}

	return text
}

export function yql<P extends any[] = unknown[]>(
	strings: string | TemplateStringsArray,
	...values: P
): { text: string; params: Record<string, Value> } {
	let params: Record<string, Value> = Object.assign({}, null)

	if (typeof strings === 'string') {
		return { text: strings, params }
	}

	let text = flatten(strings, values, params, { n: 0 })

	return { text, params }
}
