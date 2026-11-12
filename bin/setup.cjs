#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtimeUrl = pathToFileURL(
    path.join(__dirname, '..', 'plugins', 'huaweicloud-core', 'src', 'node-runtime.mjs'),
  ).href;
  const { needsSqliteFlag } = await import(runtimeUrl);

  if (needsSqliteFlag(process.versions.node) && process.env.HCDEVKIT_SQLITE_REEXEC !== '1') {
    let sqliteAvailable = true;
    try {
      require('node:sqlite');
    } catch {
      sqliteAvailable = false;
    }
    if (!sqliteAvailable) {
      process.stderr.write(
        `HuaweiCloud DevKit: enabling --experimental-sqlite for OfficeAce compatibility on Node ${process.version}.\n`,
      );
      const result = spawnSync(process.execPath, ['--experimental-sqlite', __filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, HCDEVKIT_SQLITE_REEXEC: '1' },
      });
      if (result.error) {
        console.error(result.error.message);
        process.exit(1);
      }
      process.exit(result.status ?? 1);
    }
  }

  const fileUrl = pathToFileURL(path.join(__dirname, '..', 'plugins', 'huaweicloud-core', 'src', 'setup-cli.mjs')).href;
  await import(fileUrl);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
