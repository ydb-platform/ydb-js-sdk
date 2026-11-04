---
'@ydbjs/value': major
'@ydbjs/drizzle-adapter': patch
---

Preserve extended temporal values and supported timezone values as SDK Values in default JavaScript results. Keep Date, Datetime and Timestamp results as JavaScript Date and Interval as a number; preserve Drizzle's declared Date and numeric column types.

Replace date-fns/TZDate with exact Temporal inputs and timezone text. The application supplies globalThis.Temporal; the SDK does not install or register a polyfill. Timezone constructors require Temporal for validation, including string inputs. Reject excess precision, non-ISO calendars, calendar durations and ambiguous local times.

Require TypeScript 7 or later for the standard Temporal declarations included by the published types.
