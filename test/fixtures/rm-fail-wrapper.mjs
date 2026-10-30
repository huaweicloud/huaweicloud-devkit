// Issue #1061 test hook: forces rmSync to fail for one exact path with
// EBUSY/EPERM (the Windows file-lock condition, not reproducible on Linux)
// while delegating every other node:fs export to the real implementation.
// Spawned with --experimental-test-module-mocks; the CLI module is loaded
// after the mock, so its named `node:fs` imports resolve to this mock.
import { mock } from 'node:test';
import * as realFs from 'node:fs';

const failPath = process.env.FORCE_RM_FAIL_PATH || '';
const failCode = process.env.FORCE_RM_FAIL_CODE || 'EBUSY';

const { default: _realDefault, ...realNamed } = realFs;
mock.module('node:fs', {
  namedExports: {
    ...realNamed,
    rmSync: (p, opts) => {
      if (failPath && String(p) === failPath) {
        const error = new Error(`${failCode}: resource busy or locked, rmdir '${p}'`);
        error.code = failCode;
        throw error;
      }
      return realFs.rmSync(p, opts);
    },
  },
});

await import(new URL('../../plugins/huaweicloud-core/src/setup-cli.mjs', import.meta.url).href);
