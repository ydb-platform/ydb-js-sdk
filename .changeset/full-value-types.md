---
'@ydbjs/value': minor
'@ydbjs/query': patch
---

Add typed support and public constructors for Variant, Tagged, Void and PostgreSQL values. Preserve these types as SDK values in JavaScript results, including when nested in ordinary containers.

Reject ambiguous Optional/Variant typed decoding with guidance to use raw results or an explicit YQL projection. Reject server-unsupported Tagged parameter schemas and absent Optional<Variant> parameter values before ExecuteQuery, including when nested in containers. Keep PostgreSQL text/binary data and type metadata intact, and require an explicit SQL declaration for OID-only PostgreSQL parameters.
