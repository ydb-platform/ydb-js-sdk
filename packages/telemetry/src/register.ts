/**
 * Auto-instrumentation entry point for @ydbjs/telemetry.
 *
 * Use with node --import to subscribe to all @ydbjs diagnostics channels
 * and convert them into OpenTelemetry spans without any code changes:
 *
 *   node --import @opentelemetry/sdk-node/register \
 *        --import @ydbjs/telemetry/register \
 *        your-app.js
 *
 * The OTel SDK must be initialised before this file is imported so that
 * the global tracer provider is already set up when register() runs.
 */
import { register } from './index.js'

register()
