// YDB tags every Float32 vector payload with this trailing byte so the engine
// can route opaque `String` columns to the Knn::* UDFs.
const YDB_VECTOR_MARKER = 0x01

/**
 * Pack a JS number array into the binary layout YDB's `Knn::*` UDFs expect:
 * `n × Float32 little-endian + 0x01 marker byte`. The result is stored in a
 * `String` column.
 *
 * `List<Float>` over gRPC is deliberately avoided — per-element protobuf
 * overhead bloats payloads by ~5× for typical embedding sizes.
 */
export function vectorToBytes(vector: number[]): Uint8Array {
	let result = new Uint8Array(vector.length * 4 + 1)
	let view = new DataView(result.buffer)
	for (let i = 0; i < vector.length; i++) {
		view.setFloat32(i * 4, vector[i]!, true)
	}
	result[vector.length * 4] = YDB_VECTOR_MARKER
	return result
}

/**
 * Escape a string for use inside a YQL JSON path literal (e.g. `'$.key'`).
 * JSON path keys cannot be passed as bound parameters in YQL, so escaping is
 * the only option. Not used for regular string values — those must be passed
 * as bound query parameters instead.
 */
export function escJsonPathKey(value: string): string {
	return value.replace(/'/g, "''")
}
