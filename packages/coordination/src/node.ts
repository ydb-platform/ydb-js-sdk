import type { ConsistencyMode, RateLimiterCountersMode } from '@ydbjs/api/coordination'
import type { Entry } from '@ydbjs/api/scheme'

export interface CoordinationNodeConfig {
	selfCheckPeriod?: number
	sessionGracePeriod?: number

	readConsistencyMode?: ConsistencyMode
	attachConsistencyMode?: ConsistencyMode
	rateLimiterCountersMode?: RateLimiterCountersMode
}

export interface CoordinationNodeDescription {
	self?: Entry
	config: CoordinationNodeConfig
}
