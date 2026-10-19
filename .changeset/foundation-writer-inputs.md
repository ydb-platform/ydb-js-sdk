---
'@ydbjs/topic': patch
---

Snapshot Topic writer dates and metadata at admission, copy bounded or growable payload views, and reject invalid dates or sequence numbers before accepting a message. Generate default producer identities with randomUUID().

Include metadata key/value bytes in the retained write budget and release that reservation after acknowledgments or reconnect recovery. Reject metadata above the 4096-byte per-message limit before copying it or changing writer state.

Remove the unused acknowledged payload-byte diagnostic and calculate acknowledgment status counts only when the channel has subscribers.
