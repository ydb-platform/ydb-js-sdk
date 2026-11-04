---
'@ydbjs/topic': patch
---

Stop a topic writer when the server explicitly reports that another session took over its producer, including the SESSION_EXPIRED response used by newer YDB versions. Preserve the original server error and keep retrying other expired-session errors.
