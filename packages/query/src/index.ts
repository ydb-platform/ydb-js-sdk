import { createQueryServiceClient, type QueryServiceClient } from "@ydbjs/api/query";
import type { Driver } from "@ydbjs/core";
import { fromJs, type Value } from "@ydbjs/value";
import { typeToString } from "@ydbjs/value/print";

import { Query } from "./query.js";

interface SessionContextCallback { }

interface TransactionContextCallback { }

type Isolation = ""

export interface QueryClient extends AsyncDisposable {
	<T extends any[] = unknown[], P extends any[] = unknown[]>(
		strings: string | TemplateStringsArray,
		...values: P
	): Query<T>

	// unsafe<T extends any[] = unknown[], P extends { toString(): string }[] = []>(
	// 	strings: string | TemplateStringsArray,
	// 	...values: P
	// ): YDBQuery<T>

	do<T = unknown>(fn: SessionContextCallback): Promise<T>
	do<T = unknown>(options: any, fn: SessionContextCallback): Promise<T>

	begin<T = unknown>(fn: TransactionContextCallback): Promise<T>
	begin<T = unknown>(iso: Isolation, fn: TransactionContextCallback): Promise<T>

	transaction<T = unknown>(fn: TransactionContextCallback): Promise<T>
	transaction<T = unknown>(iso: Isolation, fn: TransactionContextCallback): Promise<T>
}

export function query(db: Driver): QueryClient {
	let client: QueryServiceClient = createQueryServiceClient(db);

	let doImpl = async function <T = unknown>(): Promise<T> {
		throw new Error("Not implemented")
	}

	let beginIml = async function <T = unknown>(): Promise<T> {
		throw new Error("Not implemented")
	}

	return Object.assign(
		function yql<T extends any[] = unknown[], P extends any[] = unknown[]>(strings: string | TemplateStringsArray, ...values: P): Query<T> {
			let text = "";
			let params: Record<string, Value> = Object.assign({}, null)

			if (Array.isArray(values)) {
				values.forEach((value, i) => {
					let ydbValue = fromJs(value)

					params[`$p${i}`] = ydbValue
					text += `DECLARE $p${i} AS ${typeToString(ydbValue.type)};\n`
				})
			}

			if (typeof strings === "string") {
				text += strings
			}

			if (Array.isArray(strings)) {
				text += strings.reduce((prev, curr, i) => prev + curr + (values[i] ? `$p${i}` : ''), '')
			}

			return new Query(client, text, params)
		},
		{
			do: doImpl,
			begin: beginIml,
			transaction: beginIml,
			async [Symbol.asyncDispose]() { },
		}
	)
}
