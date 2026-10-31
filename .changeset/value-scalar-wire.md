---
'@ydbjs/value': patch
---

Encode Interval parameters using the signed 64-bit microsecond field and reject inputs that cannot represent exact integer microseconds. Keep leading zeros in TzTimestamp fractional seconds and encode Float64Array parameters as Double values.
