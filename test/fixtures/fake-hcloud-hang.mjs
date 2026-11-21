#!/usr/bin/env node
// Fake hcloud that never answers `version` — models an installed-but-stuck CLI
// (waiting on its privacy prompt, a hung wrapper, a locked HOME). The caller is
// expected to bound it with spawnSync `timeout`, so the process is killed rather
// than allowed to hold the MCP handshake.
setTimeout(() => {}, 60_000);
