export function isPartitionRevokedError(error: unknown): boolean {
	if (error instanceof AggregateError) {
		return error.errors.length > 0 && error.errors.every(isPartitionRevokedError)
	}
	if (!(error instanceof Error)) return false

	// Commit aggregates can include fatal failures alongside a revoked session.
	// Only the reader's explicit local revocation errors may be ignored on rebalance.
	return (
		error.message === 'Cannot commit a message from a stopped or expired partition session' ||
		/^Cannot commit offsets for a stopped or expired partition session \(partition .+\)$/.test(
			error.message
		) ||
		/^Partition .+ reassigned before commit was acknowledged$/.test(error.message) ||
		/^No active partition .+ to commit$/.test(error.message)
	)
}
