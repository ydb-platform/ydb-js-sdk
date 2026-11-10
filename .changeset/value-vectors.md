---
'@ydbjs/value': major
---

Add Float32Vector, Int8Vector, Uint8Vector, and BitVector values for YDB vector search. Encode numeric arrays directly into compact YDB String parameters, validate packed input, and expose owned typed-array projections. Decode known tagged vector results without constructing per-coordinate Values while preserving ordinary binary String results.

Infer native Int8Array parameters as List<Int8>; use Int8Vector explicitly for compact binary storage.
