export function uuidFromBigInts(low128: bigint, high128: bigint): string {
	// Create a 16-byte buffer
	let bytes = Buffer.alloc(16);

	// Write low128 and high128 values to the buffer in little-endian format
	bytes.writeBigUInt64LE(low128, 0);
	bytes.writeBigUInt64LE(high128, 8);

	// Swap byte order for the first three fields of the UUID (little-endian to big-endian)
	// First 4 bytes (indices 0-3)
	bytes[0] ^= bytes[3];
	bytes[3] ^= bytes[0];
	bytes[0] ^= bytes[3];

	bytes[1] ^= bytes[2];
	bytes[2] ^= bytes[1];
	bytes[1] ^= bytes[2];

	// Next 2 bytes (indices 4-5)
	bytes[4] ^= bytes[5];
	bytes[5] ^= bytes[4];
	bytes[4] ^= bytes[5];

	// Another 2 bytes (indices 6-7)
	bytes[6] ^= bytes[7];
	bytes[7] ^= bytes[6];
	bytes[6] ^= bytes[7];

	// Convert the buffer to a hexadecimal string
	let hex = bytes.toString('hex');

	// Form the UUID string
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function bigIntsFromUuid(uuid: string): { low128: bigint, high128: bigint } {
	// Remove dashes from the UUID string
	let hex = uuid.replaceAll("-", '');

	// Create a buffer from the hexadecimal string
	let bytes = Buffer.from(hex, 'hex');

	// Swap byte order for the first three fields of the UUID (big-endian to little-endian)
	// First 4 bytes (indices 0-3)
	bytes[0] ^= bytes[3];
	bytes[3] ^= bytes[0];
	bytes[0] ^= bytes[3];

	bytes[1] ^= bytes[2];
	bytes[2] ^= bytes[1];
	bytes[1] ^= bytes[2];

	// Next 2 bytes (indices 4-5)
	bytes[4] ^= bytes[5];
	bytes[5] ^= bytes[4];
	bytes[4] ^= bytes[5];

	// Another 2 bytes (indices 6-7)
	bytes[6] ^= bytes[7];
	bytes[7] ^= bytes[6];
	bytes[6] ^= bytes[7];

	// Read low128 and high128 values from the buffer in little-endian format
	let low128 = bytes.readBigUInt64LE(0);
	let high128 = bytes.readBigUInt64LE(8);

	return { low128, high128 };
}
