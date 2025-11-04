---
'@ydbjs/auth-yandex-cloud': patch
---

Fix Service Account provider: clean private key in constructor

- Move private key cleaning from JWT creation to constructor for better performance
- Remove unnecessary log about warning line detection
- Add key ID to debug logs for better traceability
- Directly modify key.private_key instead of creating new object
