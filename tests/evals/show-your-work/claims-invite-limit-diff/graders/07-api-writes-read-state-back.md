---
type: llm
focus: trace
weight: 1
---

Every api case that creates an invite (changes state) also expects the state read back after it, with a second call such as GET /api/invites, not only an HTTP status. Cases the app refuses need no read-back.
