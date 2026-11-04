---
'@ydbjs/value': minor
---

Add Decimal and DecimalType with exact string and scaled-bigint construction, binary decoding, native string projection and precision/scale validation.

Reject invalid unsigned wire words before composing the signed coefficient, so malformed values cannot be truncated into valid decimals.
