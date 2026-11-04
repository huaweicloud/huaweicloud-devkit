import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtureDir } from './fixture-dir.ts';
import {
  writeHermesMcpConfig,
  writeHermesMcpConfigResult,
  removeHermesMcpConfigBlock,
  ensureHermesMcpConfig,
  devkitChildArgsLine,
  parseArgsElements,
  readHermesDevkitPacks,
} from '../plugins/huaweicloud-core/src/agents/hermes-config.ts';

function isolatedHermesHome(): { home: string; hermesHome: string; configPath: string; restore: () => void } {
  const home = fixtureDir('hermes-merge-');
  const hermesHome = join(home, '.hermes');
  const fakeBinDir = join(home, 'fake-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeHcloud = join(fakeBinDir, 'hcloud');
  writeFileSync(fakeHcloud, '#!/bin/sh\n');
  chmodSync(fakeHcloud, 0o755);

  const saved = {
    HOME: process.env.HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    HUAWEICLOUD_HOME: process.env.HUAWEICLOUD_HOME,
    HCLOUD_BIN: process.env.HCLOUD_BIN,
    DEVKIT_PACKS: process.env.DEVKIT_PACKS,
  };
  process.env.HOME = home;
  process.env.HERMES_HOME = hermesHome;
  process.env.HUAWEICLOUD_HOME = home;
  process.env.HCLOUD_BIN = fakeHcloud;
  delete process.env.DEVKIT_PACKS;

  return {
    home,
    hermesHome,
    configPath: join(hermesHome, 'config.yaml'),
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function seedConfig(configPath: string, content: string): void {
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, content);
}

function seedDeltaBackup(home: string, extras: string[]): string {
  const backupPath = join(home, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
  mkdirSync(join(home, '.config', 'huaweicloud'), { recursive: true });
  writeFileSync(backupPath, JSON.stringify({ hermes: { argsExtra: extras } }));
  return backupPath;
}

function healAndRead(ctx: { configPath: string }, seeded: string): string {
  seedConfig(ctx.configPath, seeded);
  writeHermesMcpConfig(null);
  return readFileSync(ctx.configPath, 'utf8');
}

const userServerBlock = `model:
  provider: "openrouter"
mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
`;

function devkitChild(hermesHome: string, home: string): string {
  return `  huaweicloud-devkit:
    command: "node"
    args: ["${hermesHome}/huaweicloud-plugins/dist/mcp-server.js"]
    env:
      HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"
      HCLOUD_BIN: "${home}/fake-bin/hcloud"
`;
}

function topLevelMcpKeyCount(content: string): number {
  return (content.match(/^mcp_servers:/gm) || []).length;
}

test('install merges the devkit server under an existing mcp_servers key', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, userServerBlock);

    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, true, 'first write reports the config as changed');

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'exactly one top-level mcp_servers key after install');
    assert.match(
      cfg,
      /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"\n {4}args: \["-y", "@modelcontextprotocol\/server-filesystem", "\/tmp"\]\n {2}huaweicloud-devkit:\n/m,
      'user server and devkit child share the mcp_servers mapping',
    );
    assert.match(cfg, /^model:\n {2}provider: "openrouter"$/m, 'unrelated top-level keys survive untouched');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \[".*mcp-server\.js"\]/m,
      'devkit child is nested at sibling indent',
    );
  } finally {
    ctx.restore();
  }
});

test('install with no existing config writes the exact managed block', () => {
  const ctx = isolatedHermesHome();
  try {
    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, true, 'first write reports the config as changed');

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(
      cfg,
      `mcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}`,
      'fresh install renders the pinned block',
    );
  } finally {
    ctx.restore();
  }
});

test('install heals a config corrupted by the old duplicate-key writer', () => {
  const ctx = isolatedHermesHome();
  try {
    const corrupted = `${userServerBlock}\nmcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}`;
    seedConfig(ctx.configPath, corrupted);

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the duplicate mcp_servers key is collapsed to one');
    assert.match(cfg, /^ {2}filesystem:$/m, 'the user server survives the heal');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit server survives the heal');
  } finally {
    ctx.restore();
  }
});

test('rewrite preserves user args extras and siblings, and is idempotent', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, userServerBlock);
    writeHermesMcpConfig(null);
    const withFlag = readFileSync(ctx.configPath, 'utf8').replace(/(args: \["[^"]+")(])/, '$1, "--user-flag"$2');
    writeFileSync(ctx.configPath, withFlag);

    const changed = writeHermesMcpConfig('core');
    assert.equal(changed, true, 'rewrite reports the config as changed');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'rewrite keeps a single mcp_servers key');
    assert.match(cfg, /DEVKIT_PACKS: "core"/, 'rewrite renders the packs value');
    assert.match(cfg, /, "--user-flag"\]/, 'user-added args survive the rewrite (issue #615)');
    assert.match(
      cfg,
      /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"\n {4}args: \["-y", "@modelcontextprotocol\/server-filesystem", "\/tmp"\]\n {2}huaweicloud-devkit:\n {4}command: "node"$/m,
      'the sibling server stays nested under mcp_servers before the devkit child',
    );

    const changedAgain = writeHermesMcpConfig('core');
    assert.equal(changedAgain, false, 'an unchanged rewrite reports false');
    const cfgAgain = readFileSync(ctx.configPath, 'utf8');
    assert.equal(cfgAgain, cfg, 'an unchanged rewrite leaves the file bytes identical');
  } finally {
    ctx.restore();
  }
});

test('uninstall keeps user servers under mcp_servers when devkit sits before the sibling', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(
      ctx.configPath,
      `mcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
`,
    );

    removeHermesMcpConfigBlock();

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the mcp_servers key survives when other servers remain');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'the devkit child is gone');
    assert.match(
      cfg,
      /^mcp_servers:\n {2}filesystem:\n {4}command: "npx"$/m,
      'the sibling server stays nested under mcp_servers',
    );
  } finally {
    ctx.restore();
  }
});

test('uninstall keeps user servers under mcp_servers when devkit sits after the sibling', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, `${userServerBlock}${devkitChild(ctx.hermesHome, ctx.home)}`);

    removeHermesMcpConfigBlock();

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the mcp_servers key survives when other servers remain');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'the devkit child is gone');
    assert.doesNotMatch(cfg, /HCLOUD_BIN/, 'devkit env lines are gone');
    assert.match(cfg, /^ {2}filesystem:$/m, 'the sibling server survives');
  } finally {
    ctx.restore();
  }
});

test('uninstall drops an emptied mcp_servers key', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(
      ctx.configPath,
      `model:\n  provider: "openrouter"\nmcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}`,
    );

    removeHermesMcpConfigBlock();

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 0, 'no orphaned empty mcp_servers key remains');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'the devkit child is gone');
    assert.match(cfg, /^model:\n {2}provider: "openrouter"$/m, 'unrelated top-level keys survive');
  } finally {
    ctx.restore();
  }
});

test('install merges under an mcp_servers key carrying a trailing comment', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(
      ctx.configPath,
      'mcp_servers: # user comment\n  filesystem:\n    command: "npx"\n    args: ["-y", "pkg"]\n',
    );

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'no second mcp_servers key is appended');
    assert.match(cfg, /^mcp_servers: # user comment$/m, 'the user comment survives on the key line');
    assert.match(cfg, /^ {2}filesystem:$/m, 'the user server survives');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit child merges under the commented key');
  } finally {
    ctx.restore();
  }
});

test('install rewrites a flow-empty mcp_servers key into the block form', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'model:\n  provider: "openrouter"\nmcp_servers: {}\n');

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'no second mcp_servers key is appended');
    assert.doesNotMatch(cfg, /\{\}/, 'the flow-empty spelling is rewritten');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit child merges under the rewritten key');
  } finally {
    ctx.restore();
  }
});

test('install renders the child at a 4-space user indent without breaking the YAML', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'mcp_servers:\n    filesystem:\n        command: "npx"\n        args: ["-y", "pkg"]\n');

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'a single mcp_servers key');
    assert.match(
      cfg,
      /^ {4}huaweicloud-devkit:\n {6}command: "node"\n {6}args: \[.*mcp-server\.js"\]\n {6}env:\n {8}HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"$/m,
      'the devkit child renders at the user indent as a sibling',
    );
  } finally {
    ctx.restore();
  }
});

test('install renders the child at a 1-space user indent as a sibling, not a nested key', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'mcp_servers:\n filesystem:\n  command: "npx"\n  args: ["-y", "pkg"]\n');

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'a single mcp_servers key');
    assert.match(cfg, /^ huaweicloud-devkit:\n {3}command: "node"$/m, 'the devkit child is a 1-space sibling');
    assert.match(cfg, /^ filesystem:\n {2}command: "npx"$/m, 'the user server keeps its 1-space indent');
  } finally {
    ctx.restore();
  }
});

test('install leaves a sequence-form mcp_servers untouched', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'mcp_servers:\n  - command: "npx"\n    args: ["-y", "pkg"]\n';
    seedConfig(ctx.configPath, seeded);

    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, false, 'nothing is written for a sequence form');

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(cfg, seeded, 'the sequence form is byte-identical');
  } finally {
    ctx.restore();
  }
});

test('the extras extraction never crosses into a sibling server args line', () => {
  const ctx = isolatedHermesHome();
  try {
    const childNoArgs = '  huaweicloud-devkit:\n    command: "node"\n    env:\n      KEY: "v"';
    const sibling = '  fetch:\n    command: "npx"\n    args: ["-y", "@server-fs", "/data"]';
    seedConfig(ctx.configPath, `mcp_servers:\n${childNoArgs}\n${sibling}\n`);

    writeHermesMcpConfig(null);

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \[".*mcp-server\.js"\]$/m,
      'the devkit args line carries only the server path',
    );
    assert.match(cfg, /^ {4}args: \["-y", "@server-fs", "\/data"\]$/m, 'the sibling args line is untouched');
  } finally {
    ctx.restore();
  }
});

test('a user key carrying the devkit name under another parent survives write and remove', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'notes:\n  huaweicloud-devkit: "user note"\n');

    writeHermesMcpConfig(null);
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^notes:\n {2}huaweicloud-devkit: "user note"$/m, 'the user note survives the install');
    assert.match(cfg, /^mcp_servers:\n {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'the managed child merges');

    removeHermesMcpConfigBlock();
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^notes:\n {2}huaweicloud-devkit: "user note"$/m, 'the user note survives the uninstall');
    assert.doesNotMatch(cfg, /mcp_servers:/, 'the managed block is gone');
  } finally {
    ctx.restore();
  }
});

test('write and remove preserve CRLF line endings', () => {
  const ctx = isolatedHermesHome();
  try {
    const crlfUser = 'model:\r\n  provider: "openrouter"\r\nmcp_servers:\r\n  filesystem:\r\n    command: "npx"\r\n';
    seedConfig(ctx.configPath, crlfUser);

    writeHermesMcpConfig(null);
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.includes('\r\n'), 'the merged config keeps CRLF endings');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'a single mcp_servers key');
    assert.match(cfg, /^ {2}huaweicloud-devkit:\r\n {4}command: "node"\r\n/m, 'the devkit child merges in CRLF form');

    removeHermesMcpConfigBlock();
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.includes('\r\n'), 'the cleaned config keeps CRLF endings');
    assert.match(
      cfg,
      /^mcp_servers:\r\n {2}filesystem:\r\n {4}command: "npx"\r\n$/m,
      'the user server survives in CRLF form',
    );
  } finally {
    ctx.restore();
  }
});

test('remove drops an mcp_servers key left with only comments', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(
      ctx.configPath,
      `model:\n  provider: "openrouter"\nmcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}  # trailing note\n`,
    );

    removeHermesMcpConfigBlock();

    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 0, 'a comment-only mcp_servers body is dropped with the child');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'the devkit child is gone');
  } finally {
    ctx.restore();
  }
});

test('devkitChildArgsLine stays scoped to the managed child', () => {
  const merged = `mcp_servers:\n  filesystem:\n    command: "npx"\n    args: ["-y", "pkg"]\n${devkitChild('/tmp/h', '/tmp/h')}`;
  const line = devkitChildArgsLine(merged);
  assert.match(line ?? '', /mcp-server\.js/, 'the child args line is found');
  assert.doesNotMatch(line ?? '', /"pkg"/, 'the sibling server args never leak into the child line');

  const noChildArgs = 'mcp_servers:\n  huaweicloud-devkit:\n    command: "node"\n  fetch:\n    args: ["-y", "pkg"]\n';
  assert.equal(devkitChildArgsLine(noChildArgs), null, 'a child without its own args line returns null');
});

test('install rewrites the spaced flow-empty and null spellings into the block form', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'mcp_servers: { }\n');
    writeHermesMcpConfig(null);
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'spaced flow-empty merges without a duplicate key');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'spaced flow-empty gets the devkit child');

    seedConfig(ctx.configPath, 'mcp_servers: null\n');
    writeHermesMcpConfig(null);
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'null spelling merges without a duplicate key');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'null spelling gets the devkit child');
  } finally {
    ctx.restore();
  }
});

test('install leaves a flow-mapping mcp_servers with content untouched', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'mcp_servers: { filesystem: { command: "npx", args: ["-y", "pkg"] } }\n';
    seedConfig(ctx.configPath, seeded);

    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, false, 'a non-empty flow mapping is not mergeable');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), seeded, 'the flow mapping is byte-identical');
  } finally {
    ctx.restore();
  }
});

test('install leaves a zero-indent sequence-form mcp_servers untouched', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'mcp_servers:\n- command: "npx"\n  args: ["-y", "pkg"]\n';
    seedConfig(ctx.configPath, seeded);

    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, false, 'a zero-indent sequence is not mergeable');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), seeded, 'the sequence form is byte-identical');
  } finally {
    ctx.restore();
  }
});

test('a devkit-named key under another parent with nested args never leaks into the managed child', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'tool_settings:\n  huaweicloud-devkit:\n    args: ["--verbose", "--flag"]\n';
    seedConfig(ctx.configPath, seeded);

    assert.equal(devkitChildArgsLine(seeded), null, 'no managed child exists in the seeded config');

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {4}args: \["--verbose", "--flag"\]$/m, 'the foreign args line survives untouched');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \[".*mcp-server\.js"\]$/m,
      'the managed child carries only the server path',
    );
  } finally {
    ctx.restore();
  }
});

test('the extras parse reads the child own args line, not a nested sub-key line', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}", "--user-flag"]`,
      '    proxy:',
      '      args: ["--socks5", "host:1080"]',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {4}args: \[".*mcp-server\.js", "--user-flag"\]$/m, 'the child own extras survive');
    assert.doesNotMatch(cfg, /host:1080/, 'the nested sub-key args never inject into the managed child');
  } finally {
    ctx.restore();
  }
});

test('a single-quoted args restyle keeps its extras through the rewrite', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const restyled = `mcp_servers:\n  huaweicloud-devkit:\n    command: "node"\n    args: ['${mcpPath}', '--hdkitservice-endpoint', 'https://example.test']\n`;
    seedConfig(ctx.configPath, restyled);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(
      cfg,
      /^ {4}args: \[".*mcp-server\.js", "--hdkitservice-endpoint", "https:\/\/example\.test"\]$/m,
      'single-quoted extras survive, re-rendered double-quoted',
    );
  } finally {
    ctx.restore();
  }
});

test('remove leaves a config without a managed child byte-identical', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'model:\n  provider: "openrouter"\nmcp_servers:\n  # I will add servers later\n';
    seedConfig(ctx.configPath, seeded);

    removeHermesMcpConfigBlock();
    assert.equal(readFileSync(ctx.configPath, 'utf8'), seeded, 'a never-touched config comes back byte-identical');
  } finally {
    ctx.restore();
  }
});

test('a duplicated managed child heals to one on rewrite', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(
      ctx.configPath,
      `mcp_servers:\n${devkitChild(ctx.hermesHome, ctx.home)}${devkitChild(ctx.hermesHome, ctx.home)}`,
    );

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal((cfg.match(/^ {2}huaweicloud-devkit:/gm) || []).length, 1, 'only one managed child remains');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'a single mcp_servers key');
  } finally {
    ctx.restore();
  }
});

test('a foreign DEVKIT_PACKS line never satisfies the child packs check', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  filesystem:',
      '    command: "npx"',
      '    env:',
      '      DEVKIT_PACKS: "core"',
      `    args: ["-y", "pkg"]`,
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '    env:',
      '      HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    const changed = writeHermesMcpConfig('core');
    assert.equal(changed, true, 'the child lacks DEVKIT_PACKS so the write must fire');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \[[^\]]*\]\n {4}env:\n {6}HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local"\n {6}HCLOUD_BIN: "[^"]*"\n {6}DEVKIT_PACKS: "core"$/m,
      'the managed child gains DEVKIT_PACKS',
    );
    assert.equal((cfg.match(/DEVKIT_PACKS: "core"/g) || []).length, 2, 'the user line and the managed line coexist');
  } finally {
    ctx.restore();
  }
});

test('a mixed CRLF/LF file resolves to the dominant ending', () => {
  const ctx = isolatedHermesHome();
  try {
    const lfDominant =
      'model:\n  provider: "openrouter"\nmcp_servers:\n  filesystem:\n    command: "npx"\r\n    args: ["-y", "pkg"]\n';
    seedConfig(ctx.configPath, lfDominant);

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    const crlfLines = (cfg.match(/\r\n/g) || []).length;
    assert.ok(crlfLines <= 2, `the CRLF minority does not rewrite the whole file (crlf=${crlfLines})`);
    assert.ok(!cfg.startsWith('model:\r\n'), 'the leading LF lines keep their endings');
  } finally {
    ctx.restore();
  }
});

test('a packs rewrite keeps the mcp_servers key at its original position', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'model:\n  provider: "openrouter"\nmcp_servers:\ntheme:\n  dark: true\n');

    writeHermesMcpConfig('core');
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(
      cfg,
      /^mcp_servers:\n {2}huaweicloud-devkit:\n {4}command: "node"\n[\s\S]*^theme:$/m,
      'install fills the empty key in place',
    );

    writeHermesMcpConfig('huaweicloud-cli');
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(
      cfg,
      /^model:\n {2}provider: "openrouter"\nmcp_servers:\n {2}huaweicloud-devkit:/,
      'the rewrite keeps the key between model and theme',
    );
    assert.match(cfg, /^theme:\n {2}dark: true$/m, 'the trailing user key stays last');
  } finally {
    ctx.restore();
  }
});

test('the flow-empty rewrite preserves a leading BOM', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, '\uFEFFmcp_servers: {}\ntheme:\n  dark: true\n');

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.startsWith('\uFEFFmcp_servers:'), 'the BOM survives on the rewritten key line');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit child merges');
  } finally {
    ctx.restore();
  }
});

test('remove never eats devkit-named lines inside a user block scalar', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = [
      'mcp_servers:',
      '  my-server:',
      '    command: "node"',
      '    prompt: |',
      '      huaweicloud-devkit: fake',
      '      more prompt text',
      `  huaweicloud-devkit:`,
      `    args: ["${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js"]`,
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    removeHermesMcpConfigBlock();
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {6}huaweicloud-devkit: fake\n {6}more prompt text$/m, 'the block scalar content survives');
    assert.doesNotMatch(cfg, /^ {2}huaweicloud-devkit:$/m, 'the managed child is gone');
  } finally {
    ctx.restore();
  }
});

test('a BOM on the mcp_servers key stays visible to the scanner across write and uninstall', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = `\uFEFFmcp_servers:\n  filesystem:\n    command: "npx"\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal((cfg.match(/^ {2}huaweicloud-devkit:/gm) || []).length, 1, 'one managed child after install');
    writeHermesMcpConfig('core,obs');
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(
      (cfg.match(/^ {2}huaweicloud-devkit:/gm) || []).length,
      1,
      'a packs rewrite appends no duplicate child',
    );
    assert.equal((cfg.match(/^\uFEFF?mcp_servers:/gm) || []).length, 1, 'the BOM key stays the only mcp_servers key');

    removeHermesMcpConfigBlock();
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'uninstall removes the managed child through the BOM');
    assert.match(cfg, /^ {2}filesystem:$/m, 'the user server survives the BOM uninstall');
  } finally {
    ctx.restore();
  }
});

test('args elements with escaped quotes, brackets, and spaces survive the rewrite verbatim', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}", "--format=\\"{}\\"", "--range=[1,2]", " pad "]`,
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(
      cfg.includes('"--format=\\"{}\\"", "--range=[1,2]", " pad "]'),
      'escaped quotes, brackets, and inner spaces round-trip',
    );
  } finally {
    ctx.restore();
  }
});

test('a trailing comment on the args line defeats neither the rewrite nor the delta', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "--user-flag"] # note\n`;
    seedConfig(ctx.configPath, seeded);

    const elements = parseArgsElements(devkitChildArgsLine(seeded)!);
    assert.deepEqual(elements, [mcpPath, '--user-flag'], 'the trailing comment does not hide the extras');

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /, "--user-flag"\]/, 'the extras survive the rewrite');
  } finally {
    ctx.restore();
  }
});

test('the uninstall delta survives quotes, brackets, and apostrophes in extras', async () => {
  const ctx = isolatedHermesHome();
  try {
    const { uninstallHermes } = await import('../plugins/huaweicloud-core/src/agents/hermes.ts');
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    for (const extra of [`--note=don't`, `--range=[1,2]`, `--prefix`, `say "hi"`]) {
      const yamlExtra = extra.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      seedConfig(ctx.configPath, `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "${yamlExtra}"]\n`);
      uninstallHermes(() => 0);
      const backupPath = join(ctx.home, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
      const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { hermes?: { argsExtra?: string[] } };
      assert.deepEqual(backup.hermes?.argsExtra, [extra], `delta saved for ${extra}`);
      rmSync(backupPath, { force: true });
    }
  } finally {
    ctx.restore();
  }
});

test('a user server carrying DEVKIT_PACKS never redirects an update without --packs', () => {
  const ctx = isolatedHermesHome();
  try {
    writeHermesMcpConfig('core');
    const cfgPath = ctx.configPath;
    let cfg = readFileSync(cfgPath, 'utf8');
    cfg = cfg.replace(
      /^mcp_servers:\n {2}huaweicloud-devkit:/m,
      'mcp_servers:\n  filesystem:\n    env:\n      DEVKIT_PACKS: "obs"\n  huaweicloud-devkit:',
    );
    writeFileSync(cfgPath, cfg);

    const changed = ensureHermesMcpConfig();
    assert.equal(changed, false, 'the child own packs value is carried, not the foreign one');
    const after = readFileSync(cfgPath, 'utf8');
    assert.match(after, /^ {6}DEVKIT_PACKS: "core"$/m, 'the child keeps its own DEVKIT_PACKS');
    assert.match(after, /^ {6}DEVKIT_PACKS: "obs"$/m, 'the user server keeps its own DEVKIT_PACKS');
  } finally {
    ctx.restore();
  }
});

test('a devkit-named key nested inside a user server is user content, never the managed child', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = [
      'mcp_servers:',
      '  wrapper:',
      '    command: "npx"',
      '    huaweicloud-devkit: "passthrough option"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig(null);
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {4}huaweicloud-devkit: "passthrough option"$/m, 'the nested user key survives the install');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"\n {4}args: \[".*mcp-server\.js"\]$/m,
      'the managed child is a direct sibling, not the nested key',
    );

    removeHermesMcpConfigBlock();
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {4}huaweicloud-devkit: "passthrough option"$/m, 'the nested user key survives the uninstall');
    assert.doesNotMatch(cfg, /^ {2}huaweicloud-devkit:$/m, 'the managed child is gone');
  } finally {
    ctx.restore();
  }
});

test('healing a two-key config consolidates user servers under the first key', () => {
  const ctx = isolatedHermesHome();
  try {
    const corrupted = [
      'mcp_servers:',
      '  filesystem:',
      '    command: "npx"',
      '    args: ["-y", "pkg"]',
      '',
      'mcp_servers:',
      '  fetch:',
      '    command: "curl"',
      `${devkitChild(ctx.hermesHome, ctx.home)}`,
    ].join('\n');
    seedConfig(ctx.configPath, corrupted);

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the duplicate keys are consolidated into one');
    assert.match(cfg, /^ {2}filesystem:\n {4}command: "npx"$/m, 'the first key keeps its server');
    assert.match(cfg, /^ {2}fetch:\n {4}command: "curl"$/m, 'the relocated server joins the first key');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m,
      'the managed child lands under the single key',
    );
  } finally {
    ctx.restore();
  }
});

test('a quoted mcp_servers key spelling merges instead of duplicating', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, '"mcp_servers":\n  filesystem:\n    command: "npx"\n');

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal((cfg.match(/^["']?mcp_servers["']?:/gm) || []).length, 1, 'one mcp_servers key in any spelling');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit child merges under the quoted key');
  } finally {
    ctx.restore();
  }
});

test('consolidation moves the duplicate key body exactly once, at the sibling indent', () => {
  const ctx = isolatedHermesHome();
  try {
    const corrupted = [
      'mcp_servers:',
      '  filesystem:',
      '    command: "npx"',
      '    args: ["-y", "pkg"]',
      '',
      'mcp_servers:',
      '  fetch:',
      '    command: "curl"',
      `${devkitChild(ctx.hermesHome, ctx.home)}`,
    ].join('\n');
    seedConfig(ctx.configPath, corrupted);

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal((cfg.match(/^ {2}fetch:/gm) || []).length, 1, 'exactly one fetch server, at sibling indent');
    assert.doesNotMatch(cfg, /^ {4}fetch:/m, 'no copy nested inside filesystem');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'one mcp_servers key');
    assert.match(
      cfg,
      /^ {2}filesystem:\n {4}command: "npx"\n {4}args: \["-y", "pkg"\]$/m,
      'filesystem keeps only its own keys',
    );
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m,
      'the managed child lands under the single key',
    );

    seedConfig(ctx.configPath, corrupted);
    removeHermesMcpConfigBlock();
    const after = readFileSync(ctx.configPath, 'utf8');
    assert.equal((after.match(/^ {2}fetch:/gm) || []).length, 1, 'uninstall-side consolidation moves exactly once');
    assert.doesNotMatch(after, /^ {4}fetch:/m, 'uninstall leaves no nested copy');
    assert.equal(topLevelMcpKeyCount(after), 1, 'uninstall leaves one key');
    assert.doesNotMatch(after, /huaweicloud-devkit/, 'the managed child is gone');
  } finally {
    ctx.restore();
  }
});

test('a trailing comment ending with a bracket stays out of the args', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "--user-flag"] # see [docs]\n`;
    seedConfig(ctx.configPath, seeded);

    const elements = parseArgsElements(devkitChildArgsLine(seeded)!);
    assert.deepEqual(elements, [mcpPath, '--user-flag'], 'the comment never leaks into the elements');

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {4}args: \[".*mcp-server\.js", "--user-flag"\]$/m, 'the rendered args are clean');
  } finally {
    ctx.restore();
  }
});

test('a plain mapping key starting with a dash is a child, not a sequence item', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  -verbose: true\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "--keep-me"]\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(
      (cfg.match(/^ {2}huaweicloud-devkit:/gm) || []).length,
      1,
      'the managed child survives the packs change',
    );
    assert.match(cfg, /^ {2}-verbose: true$/m, 'the dash-prefixed user key survives');
    assert.match(cfg, /, "--keep-me"\]/, 'the user extras survive');
  } finally {
    ctx.restore();
  }
});

test('a quoted managed-child key spelling is recognized by write and remove', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  "huaweicloud-devkit":\n    args: ["${mcpPath}", "--user-flag"]\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig(null);
    let cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(
      (cfg.match(/^ {2}["']?huaweicloud-devkit["']?:/gm) || []).length,
      1,
      'one managed child in any spelling',
    );
    assert.match(cfg, /, "--user-flag"\]/, 'the quoted child extras survive');

    removeHermesMcpConfigBlock();
    cfg = readFileSync(ctx.configPath, 'utf8');
    assert.doesNotMatch(cfg, /huaweicloud-devkit/, 'the quoted child is removed');
  } finally {
    ctx.restore();
  }
});

test('a space before the colon on the mcp_servers key merges instead of duplicating', () => {
  const ctx = isolatedHermesHome();
  try {
    seedConfig(ctx.configPath, 'mcp_servers :\n  filesystem:\n    command: "npx"\n');

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal((cfg.match(/^["']?mcp_servers["']?[ \t]*:/gm) || []).length, 1, 'one key in any colon spelling');
    assert.match(cfg, /^ {2}huaweicloud-devkit:$/m, 'the devkit child merges');
  } finally {
    ctx.restore();
  }
});

test('a refused write never consumes the saved delta', () => {
  const ctx = isolatedHermesHome();
  try {
    const backupPath = seedDeltaBackup(ctx.home, ['--saved-flag']);

    seedConfig(ctx.configPath, 'mcp_servers:\n  - command: "npx"\n    args: ["-y", "pkg"]\n');
    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, false, 'the sequence form is refused');
    assert.ok(existsSync(backupPath), 'the untouched write does not burn the delta');
  } finally {
    ctx.restore();
  }
});

test('a mixed bare and flow-form mcp_servers config is left untouched whole', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}"]\nmcp_servers: { other: true }\n`;
    seedConfig(ctx.configPath, seeded);

    const changed = writeHermesMcpConfig('core');
    assert.equal(changed, false, 'a value-form key refuses the whole write');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), seeded, 'the file is byte-identical');
  } finally {
    ctx.restore();
  }
});

test('a DEVKIT_PACKS line nested under a user sub-key never satisfies the packs check', () => {
  const ctx = isolatedHermesHome();
  try {
    writeHermesMcpConfig('core');
    let cfg = readFileSync(ctx.configPath, 'utf8');
    cfg = cfg.replace(/^ {4}env:$/m, '    proxy:\n      env:\n        DEVKIT_PACKS: "obs"\n    env:');
    writeFileSync(ctx.configPath, cfg);

    assert.equal(readHermesDevkitPacks(), 'core', 'the read resolves the env-level line, not the nested one');
    const changed = writeHermesMcpConfig('obs');
    assert.equal(changed, true, 'the nested line does not satisfy the check, the write fires');
    const after = readFileSync(ctx.configPath, 'utf8');
    assert.match(after, /^ {6}DEVKIT_PACKS: "obs"$/m, 'the env-level value is rewritten');
  } finally {
    ctx.restore();
  }
});

test('a sequence-form mcp_servers key anywhere refuses the write before any mutation', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const withChildSecond = [
      'mcp_servers:',
      '  - command: "npx"',
      '    args: ["-y", "pkg"]',
      '',
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}", "--user-flag"]`,
      '',
    ].join('\n');
    seedConfig(ctx.configPath, withChildSecond);
    let changed = writeHermesMcpConfig('core');
    assert.equal(changed, false, 'the sequence shadow is refused');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), withChildSecond, 'the file is byte-identical, child intact');

    const withChildFirst = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}", "--user-flag"]`,
      '',
      'mcp_servers:',
      '  - command: "curl"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, withChildFirst);
    changed = writeHermesMcpConfig('core');
    assert.equal(changed, false, 'the trailing sequence shadow is refused too');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), withChildFirst, 'byte-identical, child intact');
  } finally {
    ctx.restore();
  }
});

test('duplicate bare mcp_servers keys with no managed child are left untouched', () => {
  const ctx = isolatedHermesHome();
  try {
    const duplicated = [
      'mcp_servers:',
      '  fetch:',
      '    command: "curl"',
      '',
      'mcp_servers:',
      '  other:',
      '    command: "npx"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, duplicated);

    const changed = writeHermesMcpConfig(null);
    assert.equal(changed, false, 'user-made duplicates are not healed by install');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), duplicated, 'the file is byte-identical');
  } finally {
    ctx.restore();
  }
});

test('YAML escape spellings in args round-trip through the rewrite byte for byte', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "-fmt\\ttab", "-nl\\nline"]\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.includes('"-fmt\\ttab", "-nl\\nline"'), 'the tab and newline escapes survive the rewrite verbatim');

    const elements = parseArgsElements(devkitChildArgsLine(cfg)!);
    assert.equal(elements?.[1], '-fmt\ttab', 'the parsed element carries the decoded tab');
    assert.equal(elements?.[2], '-nl\nline', 'the parsed element carries the decoded newline');
  } finally {
    ctx.restore();
  }
});

test('a quoted env key and a trailing comment still resolve the packs value', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '    "env":',
      '      DEVKIT_PACKS: "core,obs" # my pack selection',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    assert.equal(readHermesDevkitPacks(), 'core,obs', 'the quoted env and the comment resolve');
    const changed = ensureHermesMcpConfig();
    assert.equal(changed, false, 'the carried value satisfies the unchanged check');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /DEVKIT_PACKS: "core,obs" # my pack selection/, 'the user line is untouched');
  } finally {
    ctx.restore();
  }
});

test('a duplicate-key heal consolidates every duplicate, child under the first key', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  filesystem:',
      '    command: "npx"',
      `  huaweicloud-devkit:`,
      `    args: ["${mcpPath}"]`,
      '',
      'mcp_servers:',
      '  other:',
      '    command: "curl"',
      '',
    ].join('\n');
    const cfg = healAndRead(ctx, seeded);
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the shadowing duplicate is consolidated away');
    assert.match(cfg, /^ {2}filesystem:\n {4}command: "npx"$/m, 'the first key keeps its server');
    assert.match(cfg, /^ {2}other:\n {4}command: "curl"$/m, 'the second key server relocates in, once');
    assert.equal((cfg.match(/^ {2}other:/gm) || []).length, 1, 'other appears exactly once');
    assert.match(
      cfg,
      /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m,
      'the managed child lands under the single key',
    );
  } finally {
    ctx.restore();
  }
});

test('NEL and C1 escapes keep their values through the rewrite', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "-nel\\N", "-c1\\x80"]\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.includes('"-nel\\N"'), 'NEL re-renders as an escape, not a raw fold-prone byte');
    assert.ok(cfg.includes('"-c1\\x80"'), 'the C1 control re-renders as a hex escape');
    const elements = parseArgsElements(devkitChildArgsLine(cfg)!);
    assert.equal(elements?.[1], '-nel\u0085', 'the NEL value round-trips');
    assert.equal(elements?.[2], '-c1\u0080', 'the C1 value round-trips');
  } finally {
    ctx.restore();
  }
});

test('a hash or escaped quote inside a quoted DEVKIT_PACKS value reads whole', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '    env:',
      '      DEVKIT_PACKS: "co#re"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    assert.equal(readHermesDevkitPacks(), 'co#re', 'the hash inside quotes is value content');
    const changed = ensureHermesMcpConfig();
    assert.equal(changed, false, 'the whole value satisfies the unchanged check');
    assert.match(readFileSync(ctx.configPath, 'utf8'), /DEVKIT_PACKS: "co#re"/, 'the user value is untouched');
  } finally {
    ctx.restore();
  }
});

test('the packs slot surfaces a refused hermes write as a failure', async () => {
  const ctx = isolatedHermesHome();
  try {
    const { PACK_SLOTS } = await import('../plugins/huaweicloud-core/src/packs-cli/slots.ts');
    seedConfig(ctx.configPath, 'mcp_servers:\n  - command: "npx"\n');
    const slot = PACK_SLOTS.find((s) => s.id === 'hermes');
    const result = slot!.write('core');
    assert.ok(!result.ok, 'a refused write reports ok: false');
    assert.equal(result.reason, 'refused', 'the refusal reason is refused');
    assert.match(result.detail, /sequence/, 'the detail names the shape');
  } finally {
    ctx.restore();
  }
});

test('in-file extras take precedence over a stale uninstall delta', () => {
  const ctx = isolatedHermesHome();
  try {
    const backupPath = seedDeltaBackup(ctx.home, ['--stale-delta']);

    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    seedConfig(ctx.configPath, `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", "--manual-repair"]\n`);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /, "--manual-repair"\]/, 'the fresh in-file extras win');
    assert.doesNotMatch(cfg, /--stale-delta/, 'the stale delta never injects');
    assert.ok(!existsSync(backupPath), 'the stale delta is consumed, not left armed');
  } finally {
    ctx.restore();
  }
});

test('a failed write re-saves the consumed delta', () => {
  const ctx = isolatedHermesHome();
  try {
    const backupPath = seedDeltaBackup(ctx.home, ['--precious-extra']);

    // config.yaml as a directory: writeFileSync throws EISDIR without a
    // config ever being modified.
    mkdirSync(ctx.hermesHome, { recursive: true });
    mkdirSync(ctx.configPath);
    assert.throws(() => writeHermesMcpConfig(null), /EISDIR/);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { hermes?: { argsExtra?: string[] } };
    assert.deepEqual(backup.hermes?.argsExtra, ['--precious-extra'], 'the delta survives the failed write');
  } finally {
    ctx.restore();
  }
});

test('a quote in the hcloud path renders escaped in HCLOUD_BIN', () => {
  const ctx = isolatedHermesHome();
  try {
    const oddBin = join(ctx.home, 'fake-bin', 'hcloud"weird');
    writeFileSync(oddBin, '#!/bin/sh\n');
    process.env.HCLOUD_BIN = oddBin;

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {6}HCLOUD_BIN: "[^"]*\\"[^"]*"$/m, 'the inner quote is escaped so the line stays valid YAML');
  } finally {
    ctx.restore();
  }
});

test('a non-mapping config root is left untouched', () => {
  const ctx = isolatedHermesHome();
  try {
    const sequenceRoot = '- command: "npx"\n  args: ["-y", "pkg"]\n';
    seedConfig(ctx.configPath, sequenceRoot);
    let result = writeHermesMcpConfigResult(null);
    assert.ok(result.refused !== null, 'a sequence root is refused');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), sequenceRoot, 'byte-identical');

    const scalarRoot = 'just a scalar document\n';
    seedConfig(ctx.configPath, scalarRoot);
    result = writeHermesMcpConfigResult(null);
    assert.ok(result.refused !== null, 'a scalar root is refused');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), scalarRoot, 'byte-identical');
  } finally {
    ctx.restore();
  }
});

test('a hand-re-indented env member still resolves the packs value', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '    env:',
      '        DEVKIT_PACKS: "core,obs"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    assert.equal(readHermesDevkitPacks(), 'core,obs', 'the deeper env member resolves');
    const changed = ensureHermesMcpConfig();
    assert.equal(changed, false, 'the deeper value satisfies the unchanged check');
  } finally {
    ctx.restore();
  }
});

test('an empty-form duplicate key retires in the heal, child lands live', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers: {}',
      'mcp_servers:',
      '  filesystem:',
      '    command: "npx"',
      `  huaweicloud-devkit:`,
      `    args: ["${mcpPath}", "--keep-me"]`,
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'the empty-form duplicate is retired in one write');
    assert.match(cfg, /^ {2}filesystem:\n {4}command: "npx"$/m, 'the user server survives');
    assert.match(cfg, /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'the child lands live under the single key');
    assert.match(cfg, /, "--keep-me"\]/, 'the extras survive');
  } finally {
    ctx.restore();
  }
});

test('flow roots and document-marker mapping roots get the right verdicts', () => {
  const ctx = isolatedHermesHome();
  try {
    const flowRoot = '{ a: 1, b: 2 }\n';
    seedConfig(ctx.configPath, flowRoot);
    let result = writeHermesMcpConfigResult(null);
    assert.ok(result.refused !== null, 'a flow-mapping root is refused');
    assert.equal(readFileSync(ctx.configPath, 'utf8'), flowRoot, 'byte-identical');

    const docMarker = '---\nmodel:\n  provider: "openrouter"\n';
    seedConfig(ctx.configPath, docMarker);
    result = writeHermesMcpConfigResult(null);
    assert.ok(result.refused === null, 'a document-start mapping root merges');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^mcp_servers:\n {2}huaweicloud-devkit:$/m, 'the fresh key lands after the marker document');

    const bomRoot = '\uFEFFmodel:\n  provider: "openrouter"\n';
    seedConfig(ctx.configPath, bomRoot);
    result = writeHermesMcpConfigResult(null);
    assert.ok(result.refused === null, 'a BOM-prefixed mapping root merges');
    assert.match(
      readFileSync(ctx.configPath, 'utf8'),
      /^mcp_servers:\n {2}huaweicloud-devkit:$/m,
      'the fresh key lands',
    );
  } finally {
    ctx.restore();
  }
});

test('a column-0 comment inside a retired duplicate block drops with it', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '',
      'mcp_servers:',
      '# hand-managed',
      '  other:',
      '    command: "curl"',
      '',
    ].join('\n');
    const cfg = healAndRead(ctx, seeded);
    assert.equal(topLevelMcpKeyCount(cfg), 1, 'one key after the heal');
    assert.match(cfg, /^ {2}other:\n {4}command: "curl"$/m, 'the other server relocates in, once');
    assert.equal((cfg.match(/^ {2}other:/gm) || []).length, 1, 'other appears exactly once');
    assert.doesNotMatch(cfg, /^# hand-managed$/m, 'the retired block comment goes with the block');
    assert.match(cfg, /^ {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'the child lands under the single key');
  } finally {
    ctx.restore();
  }
});

test('unquoted args elements with mid-scalar quotes survive verbatim', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit:\n    args: ["${mcpPath}", --format="json", --note=don't]\n`;
    seedConfig(ctx.configPath, seeded);

    const elements = parseArgsElements(devkitChildArgsLine(seeded)!);
    assert.equal(elements?.[1], '--format="json"', 'a mid-scalar double quote is content');
    assert.equal(elements?.[2], "--note=don't", 'a mid-scalar apostrophe is content');

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(
      cfg.includes('"--format=\\"json\\"", "--note=don\'t"'),
      'the plain scalars re-render escaped, values intact',
    );
  } finally {
    ctx.restore();
  }
});

test('a flow-form managed child keeps its args through rewrite and delta', async () => {
  const ctx = isolatedHermesHome();
  try {
    const { uninstallHermes } = await import('../plugins/huaweicloud-core/src/agents/hermes.ts');
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  huaweicloud-devkit: {command: "node", args: ["${mcpPath}", "--precious-extra"]}\n`;
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig('core');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /, "--precious-extra"\]/, 'the flow child extras survive the rewrite');

    uninstallHermes(() => 0);
    const backupPath = join(ctx.home, '.config', 'huaweicloud', 'devkit-mcp-backup.json');
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as { hermes?: { argsExtra?: string[] } };
    assert.deepEqual(backup.hermes?.argsExtra, ['--precious-extra'], 'the uninstall delta reads the flow args');
  } finally {
    ctx.restore();
  }
});

test('an escaped DEVKIT_PACKS value round-trips through update', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = [
      'mcp_servers:',
      '  huaweicloud-devkit:',
      `    args: ["${mcpPath}"]`,
      '    env:',
      '      DEVKIT_PACKS: "co\\nre"',
      '',
    ].join('\n');
    seedConfig(ctx.configPath, seeded);

    assert.equal(readHermesDevkitPacks(), 'co\nre', 'the escaped value decodes on read');
    writeHermesMcpConfig('co\nre');
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.match(cfg, /^ {6}DEVKIT_PACKS: "co\\nre"$/m, 'the newline re-renders escaped, not raw');
    assert.equal(readHermesDevkitPacks(), 'co\nre', 'the read decodes the re-rendered value');
  } finally {
    ctx.restore();
  }
});

test('a partial packs refusal fails the command exit code', async () => {
  const ctx = isolatedHermesHome();
  try {
    const { cmdPacksWrite } = await import('../plugins/huaweicloud-core/src/packs-cli/write-command.ts');
    // A "installed" hermes payload marker plus a sequence-form config: the
    // packs write must refuse, and the refusal must fail the command.
    mkdirSync(join(ctx.hermesHome, 'huaweicloud-plugins', 'dist'), { recursive: true });
    writeFileSync(join(ctx.hermesHome, 'huaweicloud-plugins', 'dist', 'mcp-server.js'), '// stub\n');
    seedConfig(ctx.configPath, 'mcp_servers:\n  - command: "npx"\n');

    const argv = process.argv;
    process.argv = ['node', 'cli', 'packs', 'disable', 'obs'];
    process.exitCode = undefined;
    try {
      cmdPacksWrite('disable');
    } finally {
      process.argv = argv;
    }
    assert.equal(process.exitCode, 1, 'a refused write fails the packs command');
    process.exitCode = undefined;
  } finally {
    ctx.restore();
  }
});

test('a trailing document-end marker opens a new document for the fresh key', () => {
  const ctx = isolatedHermesHome();
  try {
    const seeded = 'model:\n  provider: "openrouter"\n...\n';
    seedConfig(ctx.configPath, seeded);

    writeHermesMcpConfig(null);
    const cfg = readFileSync(ctx.configPath, 'utf8');
    assert.ok(cfg.includes('...\n---\nmcp_servers:'), 'a document-start marker separates the fresh key');
    assert.match(cfg, /^mcp_servers:\n {2}huaweicloud-devkit:\n {4}command: "node"$/m, 'the fresh key lands');
  } finally {
    ctx.restore();
  }
});

test('a flow-form child env is visible to the packs reader and set math', () => {
  const ctx = isolatedHermesHome();
  try {
    const mcpPath = `${ctx.hermesHome}/huaweicloud-plugins/dist/mcp-server.js`;
    const seeded = `mcp_servers:\n  filesystem:\n    command: "npx"\n  huaweicloud-devkit: {command: "node", args: ["${mcpPath}"], env: {HUAWEICLOUD_AGENT_TOOLKIT_MODE: "local", DEVKIT_PACKS: "core"}}\n`;
    seedConfig(ctx.configPath, seeded);

    assert.equal(readHermesDevkitPacks(), 'core', 'the flow-form env value resolves');
    const changed = ensureHermesMcpConfig();
    assert.equal(changed, false, 'the carried value satisfies the unchanged check');
  } finally {
    ctx.restore();
  }
});
