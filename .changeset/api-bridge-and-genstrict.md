---
'@ydbjs/api': major
---

Regenerate the protobuf types with the bridge / multi-pile (2-DC) API: `EndpointInfo.bridge_pile_name`, `ListEndpointsResult.pile_states`, `NodeLocation.bridge_pile_name`, and a new `@ydbjs/api/bridge` export exposing `PileState` / `PileState_State`. Also pick up newer upstream fields in discovery / query / topic / monitoring.

**Breaking:** codegen moves to `protoc-gen-es` 2.12.x (aligned with the `@bufbuild/protobuf` 2.12 runtime), which honours `exactOptionalPropertyTypes`: optional message fields are now typed `T | undefined` instead of `T`. Consumers compiled with `exactOptionalPropertyTypes` that mirror generated optional fields into their own optional-typed fields must accept `undefined` (a type-level break, no behavioural change).
