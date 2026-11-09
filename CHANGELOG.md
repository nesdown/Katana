# Change log

## 2.0.0-alpha.1 (2026-11-09)

**Problem:** Katana 1 was a single Python 2 script for a Twitter API that no longer exists. It had keys in the code, broke when any site changed its layout, and could post twice after a crash.

**Fix:** Rebuilt from scratch as a TypeScript library: sources, cuts, targets and crash-safe memory, with 10 networks, AI cuts, a command line and an MCP server.

**Evidence:** Automated test suite including a real `kill -9` during posting. Read-only checks against live feeds. Publishing has not been tried on live accounts yet.
