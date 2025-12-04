---
'@ydbjs/topic': patch
---

Fix memory leaks in topic reader implementation.

- Fixed memory leaks in AsyncPriorityQueue by properly clearing items and resetting state
- Improved abort signal handling to prevent memory accumulation from composite signals
- Enhanced resource cleanup in TopicReader and TopicTxReader destroy methods
- Added proper disposal of outgoing queue and message buffers
- Added both sync and async disposal support with proper cleanup
- Added memory leak test to prevent regressions
