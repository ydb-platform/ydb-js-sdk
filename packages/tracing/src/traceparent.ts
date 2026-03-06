/**
 * Builds W3C traceparent string for propagation
 */
export function formatTraceparent(
	traceId: string,
	spanId: string,
	traceFlags: number
): string {
	let flags = traceFlags.toString(16)
	if (flags.length < 2) flags = '0' + flags
	return `00-${traceId}-${spanId}-${flags}`
}
