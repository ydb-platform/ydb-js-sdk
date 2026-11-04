---
'@ydbjs/query': patch
---

Honor a zero timeout on tagged queries instead of treating it as an absent timeout. Keep the cancellation budget consistent with the raw QueryClient.
