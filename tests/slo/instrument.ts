// Diagnostics preload. Attach with `node --import ./instrument.js` or
// `NODE_OPTIONS=--import ./instrument.js` — never imported by a workload, so the
// worker code stays clean (same way OpenTelemetry is attached out-of-band).
//
// Runs in every thread the supervisor starts (main + each worker). The topic
// writer/reader diagnostics_channel events are thread-local and only fire in the
// thread that owns the writer/reader; the other threads subscribe harmlessly.
import { subscribeTopicDiagnostics } from './lib/topic-diagnostics.ts'

// Process-lifetime subscription — no dispose needed, it lives until the thread exits.
subscribeTopicDiagnostics()
