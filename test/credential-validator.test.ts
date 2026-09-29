import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { validateIamCredentials } from '../plugins/huaweicloud-core/src/auth/credential-validator.ts';

async function withIamServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const previous = process.env.HW_IAM_ENDPOINT;
  process.env.HW_IAM_ENDPOINT = endpoint;
  try {
    return await fn(endpoint, server);
  } finally {
    if (previous === undefined) delete process.env.HW_IAM_ENDPOINT;
    else process.env.HW_IAM_ENDPOINT = previous;
    server.close();
  }
}

test('validateIamCredentials accepts valid signature and resolves region project', async () => {
  let seen = {};
  const result = await withIamServer(
    (req, res) => {
      seen = { auth: req.headers.authorization, sdkDate: req.headers['x-sdk-date'], url: req.url };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          projects: [
            { id: 'proj-other', name: 'cn-east-3' },
            { id: 'proj-target', name: 'cn-north-4' },
          ],
        }),
      );
    },
    async () => validateIamCredentials({ ak: 'TESTAK', sk: 'TESTSK123', region: 'cn-north-4' }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.projectId, 'proj-target');
  assert.equal(result.error, null);
  assert.match(seen.auth, /^SDK-HMAC-SHA256 Access=TESTAK,/);
  assert.ok(seen.sdkDate);
  assert.match(seen.url, /name=cn-north-4/);
});

test('validateIamCredentials falls back to first project without region', async () => {
  const result = await withIamServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: [{ id: 'proj-first', name: 'any-region' }] }));
    },
    () => validateIamCredentials({ ak: 'A', sk: 'S' }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.projectId, 'proj-first');
});

test('validateIamCredentials rejects invalid SK (HTTP 401)', async () => {
  const result = await withIamServer(
    (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication failed' } }));
    },
    () => validateIamCredentials({ ak: 'A', sk: 'WRONG_SK', region: 'cn-north-4' }),
  );
  assert.equal(result.valid, false);
  assert.equal(result.projectId, null);
  assert.match(result.error, /401/);
  assert.match(result.error, /Authentication failed/);
});

test('validateIamCredentials treats 403 as valid credentials without project', async () => {
  const result = await withIamServer(
    (req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Policy doesn't allow iam:projects:list" } }));
    },
    () => validateIamCredentials({ ak: 'A', sk: 'S' }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.projectId, null);
  assert.match(result.warning, /403/);
});

test('validateIamCredentials marks infrastructure errors as skipped', async () => {
  const previous = process.env.HW_IAM_ENDPOINT;
  process.env.HW_IAM_ENDPOINT = 'http://127.0.0.1:9';
  try {
    const result = await validateIamCredentials({ ak: 'A', sk: 'S' });
    assert.equal(result.valid, false);
    assert.equal(result.skipped, true);
    assert.ok(result.error);
  } finally {
    if (previous === undefined) delete process.env.HW_IAM_ENDPOINT;
    else process.env.HW_IAM_ENDPOINT = previous;
  }
});

test('validateIamCredentials fails fast without AK/SK', async () => {
  const result = await validateIamCredentials({ ak: '', sk: '' });
  assert.equal(result.valid, false);
  assert.match(result.error, /AK and SK/);
});
