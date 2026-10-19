---
'@ydbjs/core': patch
---

Keep active discovered channels alive across repeated retirement and revival. Keep explicitly pinned connections separate from discovered connections with the same node ID so invalidating one does not close the other.
