import assert from 'node:assert/strict';
import test from 'node:test';

import { clearRuntimeCredentials, setRuntimeCredentials } from '../plugins/huaweicloud-core/src/auth/credentials.ts';
import { callTool } from '../plugins/huaweicloud-core/src/tools.ts';

test('huaweicloud_explain_error maps APIGW.0301 to credential/project_id guidance', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'unknown',
    errorCode: 'APIGW.0301',
    message: 'Incorrect IAM authentication information',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Incorrect IAM authentication information/);
  assert.match(text, /auth init/);
  assert.match(text, /project_id/);
});

// A3/E2E-B1 (#935): the new ECS order-failure mappings, the Kps service
// entry, and the errorCode-only routing (real MCP calls pass only errorCode —
// the service key is derived from the dotted-code prefix).

test('huaweicloud_explain_error maps Ecs.0019 to on-sale flavor re-listing (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0019',
    message: 'the flavor does not exist',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
  assert.match(text, /replacement|替代/, 'must point at switching to a replacement flavor');
  assert.match(text, /flavors\.md/, 'must reference the flavors.md status field rules');
});

test('huaweicloud_explain_error maps Ecs.0319 to AZ-capacity guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0319',
    message: 'insufficient capacity',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone|AZ/i, 'must suggest changing the AZ');
  assert.match(text, /replacement|替代|ListFlavors/, 'must suggest switching the flavor and retrying');
});

test('huaweicloud_explain_error maps Ecs.0044 to volume-type sellout guidance (#971 A)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0044',
    message: 'the volumeType [SATA] is sellout in az[cn-north-4a]',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0044/);
  assert.match(text, /volume type|volumetype/i, 'must name the volume-type root cause');
  assert.match(text, /root_volume\.volumetype/, 'must direct at the exact parameter to change');
  assert.match(text, /Ecs\.0319/, 'must distinguish from the flavor-capacity error Ecs.0319');
  assert.match(text, /NovaListAvailabilityZones/, 'must offer the AZ-switch alternative');
});

test('huaweicloud_explain_error maps Ecs.0067 to cash-balance/recharge guidance (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0067',
    message: 'insufficient account balance',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /top up|充值/i, 'must instruct topping up');
  assert.match(text, /代金券|voucher/i, 'must explain vouchers do not count in order risk control');
});

test('huaweicloud_explain_error adds a Kps service entry mapping KPS.9004 (#935 A3)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'KPS',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  const text = JSON.stringify(result);
  assert.match(text, /KPS\.9004/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must direct at the BSS cash balance query');
  assert.match(text, /arrears|欠费|historical/i, 'must mention settling historical arrears');
  // Lowercase service alias resolves to the same mapping — asserted on the
  // mapping text, not the echoed errorCode (which would match even on a miss).
  const lower = await callTool('huaweicloud_explain_error', {
    service: 'kps',
    errorCode: 'KPS.9004',
    message: 'keypair creation restricted',
  });
  assert.match(JSON.stringify(lower), /ShowCustomerAccountBalances/);
});

test('explain_error with errorCode only (no service) hits Ecs.0019 mapping (#935 E2E-B1)', async () => {
  // MCP probe evidence: errorCode-only call returned "No known error-code
  // pattern matched", service: unknown — the service-keyed table was never hit.
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0019' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'must hit the Ecs.0019 flavor-offline mapping');
  assert.match(text, /ListFlavors/, 'must direct at hcloud ECS ListFlavors');
});

test('explain_error with errorCode only (no service) hits Ecs.0319 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0319' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0319/);
  assert.match(text, /availability zone/i, 'must hit the Ecs.0319 AZ-capacity mapping');
});

test('explain_error with errorCode only (no service) hits Ecs.0067 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0067' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0067/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must hit the cash-balance mapping without a service arg');
});

test('huaweicloud_explain_error fallback teaches context capture and error-center lookup (#648)', async () => {
  // Regression input from issue #648 EXP-E08: ECS Ecs.0103 with minimal context
  // fell into the generic fallback and produced only a "collect info" line.
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
  });
  const text = JSON.stringify(result);
  assert.match(text, /--debug/);
  assert.match(text, /X-Request-Id/);
  assert.match(text, /re-call explain_error/);
  assert.match(text, /Ecs\.0103/);
  assert.match(text, /support\.huaweicloud\.com/);
  // requestId was empty, so the support-ticket line must not appear.
  assert.doesNotMatch(text, /Provide the Request ID/);
});

test('huaweicloud_explain_error still appends support line when requestId is present', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0103',
    message: 'ECS instance startup failed',
    requestId: 'req-abc-123',
  });
  const text = JSON.stringify(result);
  assert.match(text, /Provide the Request ID \(req-abc-123\) when contacting Huawei Cloud support\./);
});

test('huaweicloud_explain_error maps Ecs.0707 to flavor/image-type combination troubleshooting (#922)', async () => {
  // Regression input from the 1024 activity report: kc2.small.2 + market-type
  // Ubuntu image → Ecs.0707 "the product does not exist", with no hint which
  // side (flavor vs image type) is wrong. Both service spellings (ECS and the
  // lowercase alias) must route to the Ecs pattern table.
  for (const service of ['ECS', 'ecs']) {
    const result = (await callTool('huaweicloud_explain_error', {
      service,
      errorCode: 'Ecs.0707',
      message: 'the product does not exist',
    })) as { suggestions?: string[] };
    const text = JSON.stringify(result);
    assert.match(text, /flavor \+ image-type combination/);
    if (service === 'ECS') {
      assert.match(text, /gold/, 'must point at gold-type images');
      assert.match(text, /market/, 'must name the market-type incompatibility');
      assert.match(text, /ListFlavors/, 'must direct at re-listing flavors');
      assert.match(text, /cond:operation/, 'must point at the AZ/status spec fields');
    }
  }
});

test('G: explain_error surfaces CREDENTIAL_EXPIRED first when temp STS has expired', async () => {
  // parseStsExpiry prioritizes HW_STS_EXPIRES_AT over the token itself — scrub
  // it (and the ambient HW_* triplet) so the expired-token setup is real.
  const prev = {
    HW_STS_EXPIRES_AT: process.env.HW_STS_EXPIRES_AT,
    HW_ACCESS_KEY: process.env.HW_ACCESS_KEY,
    HW_SECRET_KEY: process.env.HW_SECRET_KEY,
    HW_SECURITY_TOKEN: process.env.HW_SECURITY_TOKEN,
  };
  for (const key of ['HW_STS_EXPIRES_AT', 'HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN']) {
    delete process.env[key];
  }
  clearRuntimeCredentials();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const token = Buffer.from(JSON.stringify({ exp: past })).toString('base64url');
  setRuntimeCredentials('EXP_AK', 'EXP_SK', token, 'cn-north-4');
  try {
    const result = (await callTool('huaweicloud_explain_error', {
      service: 'VPC',
      errorCode: 'APIGW.0301',
      message: 'Incorrect IAM authentication information',
    })) as { suggestions?: string[] };
    const text = JSON.stringify(result);
    assert.match(text, /CREDENTIAL_EXPIRED/);
    assert.match(text, /security token has expired/i);
    assert.ok(Array.isArray(result.suggestions) && result.suggestions.length > 0);
  } finally {
    clearRuntimeCredentials();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Hermetic fake hcloud for list_operations (honors --help/help, exits 0) with
// the HCLOUD_BIN pair set around the body and restored either way.

// ── list_operations aggregate fan-out + Chinese intent keywords ─────────────

test('explain_error with errorCode only (no service) hits KPS.9004 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'KPS.9004' });
  const text = JSON.stringify(result);
  assert.match(text, /KPS\.9004/);
  assert.match(text, /ShowCustomerAccountBalances/, 'must hit the KPS.9004 restriction mapping');
});

test('explain_error with errorCode only (no service) hits existing Ecs.0707 mapping (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: 'Ecs.0707' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0707/);
  assert.match(text, /flavors\.md/, 'must hit the pre-existing Ecs.0707 mapping');
});

test('explain_error with service=unknown + dotted errorCode hits the mapping (MCP-equivalent shape) (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { service: 'unknown', errorCode: 'Ecs.0019' });
  const text = JSON.stringify(result);
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'service:unknown + dotted code must derive the service key');
});

test('explain_error with explicit service=ECS keeps behavior unchanged (#935 E2E-B1 regression)', async () => {
  const result = await callTool('huaweicloud_explain_error', {
    service: 'ECS',
    errorCode: 'Ecs.0019',
    message: 'the flavor does not exist',
  });
  const text = JSON.stringify(result);
  assert.match(text, /"service":"ECS"/, 'the echoed service field must stay as passed');
  assert.match(text, /Ecs\.0019/);
  assert.match(text, /taken offline/, 'explicit-service mapping hit must be preserved');
});

test('explain_error with dot-less errorCode and no service keeps the fallback behavior (#935 E2E-B1)', async () => {
  const result = await callTool('huaweicloud_explain_error', { errorCode: '0019' });
  const text = JSON.stringify(result);
  assert.match(text, /No known error-code pattern matched/, 'dot-less code must not be mis-routed');
  assert.ok(!text.includes('taken offline'), 'must not hit the Ecs.0019 mapping');
});

test('explain_error hits mappings for case-variant errorCodes (deliberate divergence from main)', async () => {
  // The prefix derivation resolves the service half; the entry scan is
  // case-insensitive on the code so transcriptions like ECS.0019 (console
  // echo) or kps.9004 still hit — main's port no-ops on non-canonical casing.
  const upper = await callTool('huaweicloud_explain_error', { errorCode: 'ECS.0019' });
  assert.match(JSON.stringify(upper), /taken offline/, 'uppercase-prefixed code must hit the Ecs.0019 mapping');
  const lower = await callTool('huaweicloud_explain_error', { errorCode: 'kps.9004' });
  assert.match(JSON.stringify(lower), /ShowCustomerAccountBalances/, 'lowercase code must hit the KPS.9004 mapping');
});

test('explain_error derives apic/apigw/obs prefixes and lowercase services to their tables', async () => {
  // apic → APIG: all four APIC entries were unreachable errorCode-only (the
  // uppercase fallback yields APIC, the table is keyed APIG).
  const apic = await callTool('huaweicloud_explain_error', { errorCode: 'APIC.7241' });
  assert.match(JSON.stringify(apic), /enterprise_project_id/, 'APIC.7241 must hit the APIG table via the apic alias');
  // obs service alias: service:'obs' used to miss the case-keyed OBS table.
  const obs = await callTool('huaweicloud_explain_error', {
    service: 'obs',
    errorCode: 'InvalidAccessKeyId',
    message: 'invalid access key id',
  });
  assert.match(JSON.stringify(obs), /OBS uses AK\/SK directly/, "service:'obs' must hit the OBS table");
});

// ── UX report #11/#12 (2026-11-05): the code alias and message extraction ───

test('huaweicloud_explain_error accepts the code alias like the canonical errorCode', async () => {
  const result = (await callTool('huaweicloud_explain_error', { code: 'APIGW.0301' })) as {
    errorCode: string;
    suggestions: string[];
  };
  assert.equal(result.errorCode, 'APIGW.0301');
  assert.match(result.suggestions.join('\n'), /Incorrect IAM authentication information/);
});

test('huaweicloud_explain_error extracts the code embedded in the pasted message', async () => {
  // A real service name (iam) whose own table is empty must not block the
  // prefix-derived table (APIGW) from answering the extracted code.
  const result = (await callTool('huaweicloud_explain_error', {
    service: 'iam',
    message: 'APIGW.0301 Unauthorized: Incorrect IAM authentication information',
  })) as { errorCode: string; suggestions: string[] };
  assert.equal(result.errorCode, 'APIGW.0301');
  assert.match(result.suggestions.join('\n'), /API Gateway layer error/);
  assert.match(result.suggestions.join('\n'), /Incorrect IAM authentication information/);
});

test('huaweicloud_explain_error does not promote timestamps or version strings to codes', async () => {
  for (const noise of ['Request failed after 12.3456 ms', 'client v2.0115 rejected the request']) {
    const result = (await callTool('huaweicloud_explain_error', { message: noise })) as { errorCode: string };
    assert.equal(result.errorCode, '', `"${noise}" must not become a code`);
  }
});

test('huaweicloud_explain_error does not promote glued prose to a code (loop round 2 R9)', async () => {
  // `orderfailedEcs.0707` — the left boundary keeps glued Latin text from
  // becoming the code the reply tells the user to search for.
  const result = (await callTool('huaweicloud_explain_error', {
    message: 'orderfailedEcs.0707 occurred',
  })) as { errorCode: string; suggestions: string[] };
  assert.equal(result.errorCode, '', 'glued prose must not become a code');
});

test('huaweicloud_explain_error extracts the code from the message past a placeholder errorCode (loop round 2 R9)', async () => {
  // 'N/A' is a non-code placeholder: it must not suppress message extraction
  // (the same silent drop the code alias targets, one level deeper).
  const result = (await callTool('huaweicloud_explain_error', {
    errorCode: 'N/A',
    message: 'APIGW.0301 Unauthorized: Incorrect IAM authentication information',
  })) as { errorCode: string; suggestions: string[] };
  assert.equal(result.errorCode, 'APIGW.0301');
  assert.match(result.suggestions.join('\n'), /Incorrect IAM authentication information/);
});

test('generic uppercase words before HTTP statuses do not become codes (loop round 3 S4-B2)', async () => {
  for (const noise of ['FAILED.404 not found', 'ERROR.500 internal', 'Timeout.302 after retries']) {
    const result = (await callTool('huaweicloud_explain_error', { message: noise })) as { errorCode: string };
    assert.equal(result.errorCode, '', `"${noise}" must not become a code`);
  }
});

test('symbol/short placeholder errorCodes fall through to message extraction (loop round 3 S4-B3)', async () => {
  for (const placeholder of ['*', 'TODO', '?', '0']) {
    const result = (await callTool('huaweicloud_explain_error', {
      errorCode: placeholder,
      message: 'APIGW.0301 Unauthorized: Incorrect IAM authentication information',
    })) as { errorCode: string };
    assert.equal(result.errorCode, 'APIGW.0301', `errorCode "${placeholder}" must not suppress extraction`);
  }
});

test('non-dotted identifier errorCodes keep working (the OBS table keys)', async () => {
  const result = (await callTool('huaweicloud_explain_error', {
    service: 'obs',
    errorCode: 'InvalidAccessKeyId',
    message: 'invalid access key id',
  })) as { errorCode: string; suggestions: string[] };
  assert.equal(result.errorCode, 'InvalidAccessKeyId');
  assert.match(result.suggestions.join('\n'), /OBS uses AK\/SK directly/);
});

test('the code alias wins when errorCode is placeholder-shaped (shape-gated order)', async () => {
  const result = (await callTool('huaweicloud_explain_error', {
    errorCode: 'N/A',
    code: 'APIGW.0301',
    message: 'unauthorized',
  })) as { errorCode: string };
  assert.equal(result.errorCode, 'APIGW.0301');
});

test('whitespace-padded errorCodes normalize after the shape gate (loop round 3 seat-4 O2)', async () => {
  const result = (await callTool('huaweicloud_explain_error', {
    errorCode: ' Ecs.0019 ',
    message: 'flavor offline',
  })) as { errorCode: string; suggestions: string[] };
  assert.equal(result.errorCode, 'Ecs.0019');
  assert.match(result.suggestions.join('\n'), /Ecs\.0019/);
});
