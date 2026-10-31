---
'@ydbjs/value': patch
---

Preserve the supplied schema when decoding values, including nested Optional presence, typed empty and nullable containers, struct field order, and both UUID halves. Reject incompatible container and primitive schemas and out-of-range integer values before encoding, and allow explicit List and Dict types for empty parameters.

Apply the same value classification inside arrays as for standalone values, and reject conflicting inferred record fields instead of silently reinterpreting their contents. Decode Decimal, empty container types, extended date/time types, Interval and DyNumber using their supported JavaScript representations, and interpret timezone dates in their declared timezone.
