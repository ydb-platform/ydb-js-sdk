import type { Span } from '@opentelemetry/api'
export type SpanBaseAttributes = {
	'server.address': string
	'server.port': number
	'db.namespace'?: string
}
export declare function getBaseAttributes(
	serverAddress: string,
	serverPort: number,
	dbNamespace?: string
): SpanBaseAttributes & {
	'db.system': string
}
export declare function createSpan<T>(
	operationName: string,
	baseAttributes: SpanBaseAttributes & {
		'db.system'?: string
	},
	fn: (span: Span) => Promise<T>
): Promise<T>
//# sourceMappingURL=span.d.ts.map
