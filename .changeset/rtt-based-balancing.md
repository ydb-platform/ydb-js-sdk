---
'@ydbjs/core': minor
---

Add RTT-based local DC detection and location-aware client balancing

**New Features:**

- Add `createClientWithOptions()` method for location-aware client balancing
- Add `ClientOptions` interface with `preferLocalDC`, `preferredLocations`, `preferNodeId`, and `allowFallback` options
- Add automatic local DC detection via RTT measurement during discovery
- Add driver options: `ydb.sdk.enable_local_dc_detection` and `ydb.sdk.local_dc_detection_timeout_ms`

**New Modules:**

- `rtt.ts` - TCP RTT measurement utilities (`measureTCPRTT`, `measureFastest`, `measureAll`)
- `local-dc.ts` - Local DC detection algorithm with endpoint sampling

**Usage:**

```typescript
// Enable automatic local DC detection during discovery
let driver = new Driver('grpcs://ydb.example.com:2135/mydb', {
  'ydb.sdk.enable_local_dc_detection': true,
  'ydb.sdk.local_dc_detection_timeout_ms': 5000, // optional, default 5000ms
})

// Create client that prefers detected local DC
let client = driver.createClientWithOptions(QueryService, {
  preferLocalDC: true, // use auto-detected local DC
  allowFallback: true, // fallback to other DCs if local unavailable
})

// Or prefer specific locations with strict filtering
let client = driver.createClientWithOptions(QueryService, {
  preferredLocations: ['VLA', 'SAS'],
  allowFallback: false, // only use VLA or SAS, fail if unavailable
})

// Or prefer specific node by ID
let client = driver.createClientWithOptions(QueryService, {
  preferNodeId: 12345n,
})

// Combine options: prefer node in specific locations
let client = driver.createClientWithOptions(QueryService, {
  preferNodeId: 12345n,
  preferredLocations: ['VLA'],
  allowFallback: true,
})
```

**Implementation Details:**

- Local DC detection samples 5 random endpoints per location to reduce overhead
- Uses `Promise.any()` to race TCP connections and find fastest location
- Connection pool filters by location when `preferredLocations` or `preferLocalDC` specified
- `preferredLocations` takes precedence over `preferLocalDC`
- Round-robin balancing within filtered connection set
- `allowFallback: false` ensures strict location filtering (no fallback to all endpoints)
- `preferNodeId` works within filtered connection set

**Backward Compatibility:**

All existing APIs remain unchanged. The new `createClientWithOptions()` method and driver options are additive.
