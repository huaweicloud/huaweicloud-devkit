import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import {
  confirmApprovalToken,
  consumeApprovalToken,
  createApprovalToken,
  hashArgs,
  inspectApprovalToken,
  verifyConfirmationGrant,
} from '../plugins/huaweicloud-core/src/lib/approval-tokens.ts';
import { clearCustodyCache } from '../plugins/huaweicloud-core/src/lib/secret-vault/custody.ts';
import { fixtureDir } from './fixture-dir.ts';

// The round-2 hardening of the CLI face's approval store: canonical
// hashing (agent re-serialization cannot change a token's hash) and the
// exclusive-create marker that closes the two-process double-consume window.

function withAuthHome(fn: () => void | Promise<unknown>): () => Promise<void> {
  return async () => {
    const previous = process.env.HUAWEICLOUD_HOME;
    const home = fixtureDir('approval-home-');
    process.env.HUAWEICLOUD_HOME = home;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = previous;
    }
  };
}

// The confirmation battery needs a deterministic custody tier: a fixed env
// master key (HW_VAULT_MASTER_KEY, the CI tier the vault already documents)
// over the per-test fresh home. The custody cache is cleared on both ends so
// a key swap inside one test can never observe a stale tier.
const TEST_MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64');

function withVaultHome(fn: () => void | Promise<unknown>): () => Promise<void> {
  return withAuthHome(() => {
    const previousKey = process.env.HW_VAULT_MASTER_KEY;
    process.env.HW_VAULT_MASTER_KEY = TEST_MASTER_KEY;
    clearCustodyCache();
    try {
      return fn();
    } finally {
      clearCustodyCache();
      if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
      else process.env.HW_VAULT_MASTER_KEY = previousKey;
    }
  });
}

function approvalsFile(): string {
  return join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals.json');
}

// Direct-store reads/writes stand in for the attacker: approvals.json is
// same-user editable, so the tests mutate it by hand.
function readStore(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(approvalsFile(), 'utf8'));
}

function writeStore(map: Record<string, unknown>): void {
  writeFileSync(approvalsFile(), JSON.stringify(map));
}

function backdate(token: string): void {
  const map = readStore();
  map[token]!.createdAt = Date.now() - 6 * 60_000;
  writeStore(map);
}

test('hashArgs is canonical: key order never changes the hash', () => {
  assert.equal(hashArgs({ b: 2, a: 1 }), hashArgs({ a: 1, b: 2 }));
  assert.equal(
    hashArgs({ z: { y: [{ b: 2, a: 1 }], x: 'k' }, m: [3, 2, 1] }),
    hashArgs({ m: [3, 2, 1], z: { x: 'k', y: [{ a: 1, b: 2 }] } }),
    'sorting is recursive',
  );
  // Arrays keep their order: order is semantic (a CLI command's argv).
  assert.notEqual(hashArgs(['a', 'b']), hashArgs(['b', 'a']));
  // undefined-valued keys stringify away on both sides — pinned so nobody
  // "fixes" it into a behavior change for in-flight tokens.
  assert.equal(hashArgs({ a: 1, b: undefined }), hashArgs({ a: 1 }));
});

test('hashArgs sees nested __proto__ keys: the prototype-setter bypass is closed', () => {
  // JSON.parse makes __proto__ an OWN property; a plain-object canonical
  // target invoked the prototype setter instead, dropping the key from
  // the hash — so an approved form and a smuggled __proto__ replay hashed
  // identically (round-5 probe). The null-prototype target keeps it.
  const base = JSON.parse('{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1}}}');
  const smuggled = JSON.parse(
    '{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1,"__proto__":{"admin":true}}}}',
  );
  assert.notEqual(hashArgs(base), hashArgs(smuggled), 'a __proto__ payload must not hash as its clean form');
  assert.equal(
    hashArgs(smuggled),
    hashArgs(JSON.parse(JSON.stringify(smuggled))),
    'round-trip stability for the smuggled form',
  );
});

test(
  'the full mint/consume path round-trips a __proto__-bearing approval',
  withAuthHome(() => {
    // hashArgs alone does not cover the file round-trip: the persisted
    // entry's argsHash must survive JSON serialization of the store and
    // still distinguish the smuggled form.
    const smuggled = JSON.parse(
      '{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1,"__proto__":{"admin":true}}}}',
    );
    const clean = JSON.parse('{"tool":"t","toolArgs":{"product":"ECS","extra":{"safe":1}}}');
    const smuggledToken = createApprovalToken(smuggled);
    const cleanToken = createApprovalToken(clean);

    const fromSmuggled = consumeApprovalToken(smuggledToken);
    assert.ok(fromSmuggled, 'the smuggled entry is consumable');
    assert.equal(fromSmuggled.argsHash, hashArgs(smuggled));
    assert.notEqual(fromSmuggled.argsHash, hashArgs(clean), 'the stored hash keeps the smuggled form distinct');

    const wrongShape = consumeApprovalToken(cleanToken);
    assert.ok(wrongShape);
    assert.notEqual(wrongShape.argsHash, fromSmuggled.argsHash);
  }),
);

test('hashArgs serializes DAG-aliased references structurally, not as null', () => {
  // Round-7: the seen-set was a global visited set — the second reference
  // to the same object collapsed to null, making {a:X,b:X} hash identically
  // to {a:X,b:null}. A recursion-path set (add before, delete after)
  // serializes the DAG faithfully; only true cycles collapse.
  const shared = { k: 1 };
  const aliased = { a: shared, b: shared };
  const expanded = { a: { k: 1 }, b: { k: 1 } };
  const withNull = { a: { k: 1 }, b: null };
  assert.equal(hashArgs(aliased), hashArgs(expanded), 'aliasing does not change the hash');
  assert.notEqual(hashArgs(aliased), hashArgs(withNull), 'a null sibling is a different value');
  // True cycles still terminate — objects AND arrays (round-8: the array
  // branch bypassed the recursion-path set and a self-referential array
  // threw RangeError).
  const cyclic: Record<string, unknown> = { k: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => hashArgs(cyclic));
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  assert.doesNotThrow(() => hashArgs({ tool: 't', toolArgs: { x: cyclicArray } }));
});

test(
  'single-use is enforced by an exclusive-create marker next to the store',
  withAuthHome(() => {
    const token = createApprovalToken({ tool: 'execute_api', toolArgs: { product: 'ECS', api: 'ListServers' } });
    const first = consumeApprovalToken(token);
    assert.ok(first, 'the first consume wins');
    assert.equal(
      first.argsHash,
      hashArgs({ tool: 'execute_api', toolArgs: { api: 'ListServers', product: 'ECS' } }),
      'the stored hash is order-insensitive to how the mint payload was written',
    );

    assert.equal(consumeApprovalToken(token), null, 'replay is rejected by the marker, not just the file');
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    assert.ok(existsSync(join(markerDir, `${token}.claimed`)), 'the claim marker is on disk');
  }),
);

test(
  'consumed markers are pruned long after the TTL window',
  withAuthHome(() => {
    const token = createApprovalToken(['OBS', 'ls']);
    consumeApprovalToken(token);
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    const marker = join(markerDir, `${token}.claimed`);
    assert.ok(existsSync(marker));

    // Age the marker past the prune threshold (4x TTL) and mint again: the
    // mint pass sweeps stale markers alongside stale entries.
    const aged = new Date(Date.now() - 6 * 60_000 * 4);
    utimesSync(marker, aged, aged);
    createApprovalToken(['OBS', 'stat']);
    assert.ok(!existsSync(marker), 'the aged marker is pruned by the next mint');
    const remaining = readdirSync(markerDir);
    assert.ok(remaining.every((name) => name !== `${token}.claimed`));
  }),
);

test(
  'the claim marker, not the file deletion, rejects a racing second consumer',
  withAuthHome(() => {
    const token = createApprovalToken({ tool: 't', toolArgs: { a: 1 } });
    const first = consumeApprovalToken(token);
    assert.ok(first, 'the first consume wins and tombstones the entry');

    // Simulate the racing reader: it read the store BEFORE the winner's
    // tombstone landed, so the entry is back while the marker exists. Only
    // the exclusive-create marker can reject this replay — if the marker
    // gate regresses, this consume would succeed and the test fails.
    const file = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map[token] = { argsHash: first.argsHash, argsRedacted: first.argsRedacted, createdAt: Date.now() };
    writeFileSync(file, JSON.stringify(map));
    assert.equal(consumeApprovalToken(token), null, 'the replayed token must be rejected by the marker');
    assert.equal(consumeApprovalToken(token), null, 'and stays rejected');
  }),
);

test(
  'bogus tokens have zero filesystem side effects',
  withAuthHome(() => {
    const probe = `trav-probe-${process.pid}`;
    for (const bogus of ['not-a-uuid', `../../../../${probe}`, '', 'UPPERCASE-NOT-A-TOKEN', `${probe}`]) {
      assert.equal(consumeApprovalToken(bogus), null);
    }
    const markerDir = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'approvals-consumed');
    assert.ok(
      !existsSync(markerDir) || readdirSync(markerDir).length === 0,
      'no marker files may be created for bogus tokens',
    );
    // The traversal string must not have escaped the (never-created) marker dir.
    assert.ok(!existsSync(join(tmpdir(), `${probe}.claimed`)), 'no traversal escape into tmpdir');
    assert.ok(!existsSync(join(process.env.HUAWEICLOUD_HOME!, `${probe}.claimed`)), 'no traversal escape into home');
  }),
);

// ── Terminal confirmation: state machine, custody-bound grant ────────────────
// The agent can mint a token but cannot speak for the user: only
// confirmApprovalToken writes user_confirmed, and only with a grant mac keyed
// on the vault custody secret — so a same-user hand-edit of approvals.json
// can flip the state string but never produce a verifying grant.

test(
  'a fresh mint awaits the user: no grant, verify fails closed',
  withVaultHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid');
    assert.ok(inspection.entry);
    assert.equal(inspection.entry.state, 'awaiting_user', 'mints start awaiting the user terminal confirmation');
    assert.equal(inspection.entry.confirmGrant, undefined, 'no grant exists before any confirmation');

    assert.equal(verifyConfirmationGrant(inspection.entry, token).ok, false, 'an unconfirmed token must not verify');
  }),
);

test(
  'confirm flips awaiting_user to user_confirmed, persists a grant, and never consumes',
  withVaultHome(() => {
    const token = createApprovalToken(['ECS', 'DeleteServer', '--server_id=x']);
    assert.equal(confirmApprovalToken(token).status, 'confirmed');

    const inspection = inspectApprovalToken(token);
    assert.equal(inspection.state, 'valid', 'confirm must not consume the token');
    assert.ok(inspection.entry);
    assert.equal(inspection.entry.state, 'user_confirmed');
    assert.ok(inspection.entry.confirmGrant, 'the confirmed entry carries a grant');
    assert.equal(typeof inspection.entry.confirmGrant.confirmedAt, 'number');
    assert.match(inspection.entry.confirmGrant.mac, /^[0-9a-f]{64}$/, 'the grant mac is a sha256 hex digest');

    assert.ok(verifyConfirmationGrant(inspection.entry, token).ok, 'the confirmed token verifies');
    assert.ok(consumeApprovalToken(token), 'a confirmed token remains consumable by the run side');
  }),
);

test(
  'confirm is idempotent: a second call keeps the single original grant',
  withVaultHome(() => {
    const token = createApprovalToken(['OBS', 'rm', 'obs://bucket/key']);
    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    const before = readStore()[token]!;

    const second = confirmApprovalToken(token);
    assert.equal(second.status, 'already_confirmed');
    assert.deepEqual(readStore()[token]!, before, 'no rewrite: state and grant stay byte-identical');
  }),
);

test(
  'confirm classifies bogus, unknown, expired, and consumed tokens without side effects',
  withVaultHome(() => {
    assert.equal(confirmApprovalToken('not-a-uuid').status, 'not_found');
    assert.equal(confirmApprovalToken(randomUUID()).status, 'not_found');
    assert.ok(!existsSync(approvalsFile()), 'refusals create no store file');

    const expired = createApprovalToken(['ECS', 'DeleteServer']);
    backdate(expired);
    assert.equal(confirmApprovalToken(expired).status, 'expired');
    const stored = readStore()[expired]!;
    assert.equal(stored.state, 'awaiting_user', 'an expired confirm never flips state');
    assert.equal(stored.confirmGrant, undefined, 'and never mints a grant');

    const consumed = createApprovalToken(['ECS', 'DeleteServer']);
    assert.ok(consumeApprovalToken(consumed));
    assert.equal(confirmApprovalToken(consumed).status, 'already_consumed');
  }),
);

test(
  'a hand-edited store cannot forge a confirmation: missing, fabricated, or transplanted grants all fail',
  withVaultHome(() => {
    const attacker = createApprovalToken(['ECS', 'DeleteServer', '--server_id=victim']);

    const flipped = readStore();
    flipped[attacker] = { ...flipped[attacker]!, state: 'user_confirmed' };
    writeStore(flipped);
    let entry = inspectApprovalToken(attacker).entry!;
    assert.equal(entry.state, 'user_confirmed', 'the hand-edit reached the store read');
    assert.equal(
      verifyConfirmationGrant(entry, attacker).ok,
      false,
      'state without a grant does not verify: the state string is not the authorization',
    );

    const fabricated = readStore();
    fabricated[attacker] = {
      ...fabricated[attacker]!,
      confirmGrant: { confirmedAt: Date.now(), mac: 'f'.repeat(64) },
    };
    writeStore(fabricated);
    entry = inspectApprovalToken(attacker).entry!;
    assert.equal(
      verifyConfirmationGrant(entry, attacker).ok,
      false,
      'a fabricated mac does not verify without the custody secret',
    );

    // A REAL grant, copied from a legitimately confirmed entry: the mac binds
    // token and command hash, so the transplant does not verify either.
    const legit = createApprovalToken(['ECS', 'DeleteServer', '--server_id=other']);
    assert.equal(confirmApprovalToken(legit).status, 'confirmed');
    const legitGrant = readStore()[legit]!.confirmGrant;
    const transplanted = readStore();
    transplanted[attacker] = { ...transplanted[attacker]!, confirmGrant: legitGrant };
    writeStore(transplanted);
    entry = inspectApprovalToken(attacker).entry!;
    assert.equal(
      verifyConfirmationGrant(entry, attacker).ok,
      false,
      'a grant copied from another token does not verify',
    );
    assert.ok(
      verifyConfirmationGrant(inspectApprovalToken(legit).entry!, legit).ok,
      'the legitimate confirmation still verifies',
    );
  }),
);

test(
  'legacy entries without state read as awaiting_user',
  withVaultHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const map = readStore();
    delete map[token]!.state;
    writeStore(map);

    const inspection = inspectApprovalToken(token);
    assert.ok(inspection.entry);
    assert.equal(inspection.entry.state, undefined, 'a deleted state field stays deleted through the whitelist');
    assert.equal(confirmApprovalToken(token).status, 'confirmed', 'a legacy entry confirms like an awaiting one');

    const confirmed = inspectApprovalToken(token);
    assert.ok(confirmed.entry);
    assert.ok(verifyConfirmationGrant(confirmed.entry, token).ok);
  }),
);

test(
  'malformed state and grant fields read as absent (fail closed)',
  withVaultHome(() => {
    const token = createApprovalToken(['ECS', 'ListServersDetails']);
    const mangled = readStore();
    mangled[token] = { ...mangled[token]!, state: 'banana', confirmGrant: { confirmedAt: 'soon', mac: 42 } };
    writeStore(mangled);

    const inspection = inspectApprovalToken(token);
    assert.ok(inspection.entry);
    assert.equal(inspection.entry.state, undefined, 'an unknown state string is dropped');
    assert.equal(inspection.entry.confirmGrant, undefined, 'a wrong-shaped grant is dropped');

    const handConfirmed = readStore();
    handConfirmed[token] = { ...handConfirmed[token]!, state: 'user_confirmed' };
    writeStore(handConfirmed);
    const entry = inspectApprovalToken(token).entry!;
    assert.equal(entry.state, 'user_confirmed', 'a valid state string survives the whitelist');
    assert.equal(
      verifyConfirmationGrant(entry, token).ok,
      false,
      'user_confirmed without a shape-valid grant fails closed',
    );
  }),
);

test(
  'confirm rewrites the whitelisted entry: minted fields survive, planted fields drop',
  withVaultHome(() => {
    const token = createApprovalToken(['RDS', 'CreateInstance', '--password=<password>'], {
      secretsSubstitutable: true,
      argsPinView: ['RDS', 'CreateInstance', '--password=<redacted>'],
    });
    const planted = readStore();
    planted[token] = { ...planted[token]!, plantedByAttacker: 'must-not-survive' };
    writeStore(planted);

    assert.equal(confirmApprovalToken(token).status, 'confirmed');
    const stored = readStore()[token]!;
    assert.equal(stored.secretsSubstitutable, true, 'the minted substitutable flag survives the confirm rewrite');
    assert.deepEqual(stored.argsPinView, ['RDS', 'CreateInstance', '--password=<redacted>']);
    assert.equal(stored.plantedByAttacker, undefined, 'confirm drops fields outside the whitelist');
    assert.ok(verifyConfirmationGrant(inspectApprovalToken(token).entry!, token).ok);
  }),
);

test(
  'a broken custody tier fails closed: confirm refuses to flip, verify rejects',
  withVaultHome(() => {
    const confirmedToken = createApprovalToken(['ECS', 'DeleteServer', '--id=1']);
    assert.equal(confirmApprovalToken(confirmedToken).status, 'confirmed');

    // A vault record under the home pins ensureMasterKey to loud failure: with
    // records present, a broken tier is a lost key, not a fresh vault.
    const root = join(process.env.HUAWEICLOUD_HOME!, '.config', 'huaweicloud', 'secrets', 'testscope');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'record.json'), '{}');

    const pendingToken = createApprovalToken(['ECS', 'DeleteServer', '--id=2']);
    const previousKey = process.env.HW_VAULT_MASTER_KEY;
    process.env.HW_VAULT_MASTER_KEY = 'not-32-bytes';
    clearCustodyCache();
    try {
      const refused = confirmApprovalToken(pendingToken);
      assert.equal(refused.status, 'custody_unavailable');
      assert.match(refused.reason ?? '', /HW_VAULT_MASTER_KEY/);
      assert.equal(readStore()[pendingToken]!.state, 'awaiting_user', 'the refused entry stays awaiting');

      const entry = inspectApprovalToken(confirmedToken).entry!;
      assert.equal(verifyConfirmationGrant(entry, confirmedToken).ok, false, 'no grant verifies under a broken tier');
    } finally {
      if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
      else process.env.HW_VAULT_MASTER_KEY = previousKey;
      clearCustodyCache();
    }
  }),
);

test(
  'an unresolvable master key fails closed on verify',
  withVaultHome(() => {
    const token = createApprovalToken(['ECS', 'DeleteServer']);
    assert.equal(confirmApprovalToken(token).status, 'confirmed');

    const previousKey = process.env.HW_VAULT_MASTER_KEY;
    delete process.env.HW_VAULT_MASTER_KEY;
    clearCustodyCache();
    try {
      const result = verifyConfirmationGrant(inspectApprovalToken(token).entry!, token);
      assert.equal(result.ok, false, 'with no resolvable key the mac cannot be recomputed');
      assert.equal(typeof result.reason, 'string');
    } finally {
      if (previousKey === undefined) delete process.env.HW_VAULT_MASTER_KEY;
      else process.env.HW_VAULT_MASTER_KEY = previousKey;
      clearCustodyCache();
    }
  }),
);
