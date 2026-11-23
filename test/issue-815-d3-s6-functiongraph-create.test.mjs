// #815 / D3-S6 — the FunctionGraph timer scenario (new-fg-rds-probe) failed
// because the CreateFunction example named only the operation, so the agent
// assembled the request body itself and the API rejected the call on a
// mandatory field that the releases named differently (function_name,
// code.filename, code.zip_file). These cases pin the three fixes: the example
// carries the whole minimal parameter set, the pre-execution check reports one
// canonical field name whatever spelling the caller used, and a timer trigger
// may not be batched with the function it needs the URN from.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FUNCTIONGRAPH_CODE_SOURCE,
  FUNCTIONGRAPH_CREATE_ALIASES,
  FUNCTIONGRAPH_CREATE_REQUIRED,
  planHcloudCommand,
} from '../plugins/huaweicloud-core/src/hcloud-cli.mjs';
import { SERVICE_EXAMPLES, callTool } from '../plugins/huaweicloud-core/src/tools.mjs';

const FUNCTION_NAME = 'new-fg-rds-probe';
const FUNCTION_URN = `urn:fss:cn-north-4:0000000000000000000000000000000a:function:default:${FUNCTION_NAME}:latest`;

function argsFromExample(example) {
  return example.split(/\s+/).filter(Boolean);
}

function flagsOf(args) {
  return args.filter((arg) => String(arg).startsWith('--')).map((arg) => arg.slice(2).split('=')[0]);
}

// The minimal scenario as it should be assembled: every mandatory field the
// CreateFunction contract wants, inline code included.
function createFunctionArgs(overrides = {}) {
  const args = [
    'FunctionGraph',
    'CreateFunction',
    `--func_name=${FUNCTION_NAME}`,
    '--package=default',
    '--runtime=Python3.10',
    '--handler=index.handler',
    '--memory_size=128',
    '--timeout=3',
    '--code_type=inline',
    '--func_code.file=aW1wb3J0IGpzb24K',
    '--cli-region=cn-north-4',
  ];
  return overrides.args || args;
}

function timerTriggerArgs(urn, name = 'new-fg-rds-probe-timer') {
  return [
    'FunctionGraph',
    'CreateFunctionTrigger',
    `--function_urn=${urn}`,
    '--trigger_type_code=TIMER',
    '--event_type_code=MessageCreated',
    '--trigger_status=ACTIVE',
    `--event_data.name=${name}`,
    '--event_data.schedule_type=Rate',
    '--event_data.schedule=1m',
  ];
}

function withSandboxHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'issue-815-home-'));
  const previous = process.env.HUAWEICLOUD_HOME;
  process.env.HUAWEICLOUD_HOME = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.HUAWEICLOUD_HOME;
      else process.env.HUAWEICLOUD_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    });
}

const missingWarnings = (plan) => plan.warnings.filter((w) => String(w).startsWith('Missing required parameters:'));
const correctionWarnings = (plan) =>
  plan.warnings.filter((w) => String(w).includes('is a request-body field name, not a KooCLI parameter'));

test('the FunctionGraph create example carries the whole minimal parameter set', () => {
  const example = SERVICE_EXAMPLES.FUNCTIONGRAPH.create;
  const flags = flagsOf(argsFromExample(example));

  for (const param of FUNCTIONGRAPH_CREATE_REQUIRED) {
    assert.ok(flags.includes(param), `example must pass --${param}: ${example}`);
  }
  assert.ok(
    FUNCTIONGRAPH_CODE_SOURCE.some((param) => flags.includes(param)),
    `example must pass a code payload flag (${FUNCTIONGRAPH_CODE_SOURCE.join(', ')}): ${example}`,
  );
  assert.equal(flags[0], 'func_name', 'the function name is the first mandatory flag to assemble');
});

test('a create call assembled from the contract raises no missing-parameter warning', () => {
  const plan = planHcloudCommand(createFunctionArgs());
  assert.deepEqual(missingWarnings(plan), []);
  assert.deepEqual(correctionWarnings(plan), []);
});

test('the example command itself passes the pre-execution check', () => {
  const plan = planHcloudCommand(argsFromExample(SERVICE_EXAMPLES.FUNCTIONGRAPH.create));
  assert.deepEqual(missingWarnings(plan), []);
});

test('a create call missing the code payload names the canonical code flag', () => {
  const args = createFunctionArgs().filter((arg) => !arg.startsWith('--func_code.file'));
  const plan = planHcloudCommand(args);
  const [missing] = missingWarnings(plan);
  assert.ok(missing, 'a code-less create must be flagged before the API call');
  assert.ok(missing.includes('func_code.file'), `canonical code flag expected, got: ${missing}`);
});

test('body-field spellings are reported under the canonical flag, not the spelling used', () => {
  const spellings = ['function_name', 'funcname'];
  const reported = spellings.map((spelling) => {
    const args = createFunctionArgs().map((arg) =>
      arg.startsWith('--func_name=') ? arg.replace('--func_name', `--${spelling}`) : arg,
    );
    const plan = planHcloudCommand(args);
    assert.ok(
      correctionWarnings(plan).some((w) => w.includes(`--${spelling}`) && w.includes('--func_name')),
      `the plan must correct --${spelling} to --func_name: ${JSON.stringify(plan.warnings)}`,
    );
    return missingWarnings(plan).join(' | ');
  });
  // One defect, one field name: the missing list is identical whatever spelling
  // the caller chose, so the error no longer floats across versions.
  assert.equal(new Set(reported).size, 1, `canonical report must not float: ${JSON.stringify(reported)}`);
  assert.ok(reported[0].includes('func_name'), `canonical name expected: ${reported[0]}`);
  assert.ok(!reported[0].includes('function_name'), `body name must not leak into the missing list: ${reported[0]}`);
});

test('code payload body-field spellings map onto the canonical code flag', () => {
  const cases = {
    'code.filename': 'code_filename',
    'code.zip_file': 'func_code.file',
  };
  for (const [spelling, canonical] of Object.entries(cases)) {
    const args = createFunctionArgs()
      .filter((arg) => !arg.startsWith('--func_code.file'))
      .concat(`--${spelling}=function.zip`);
    const plan = planHcloudCommand(args);
    const missing = missingWarnings(plan).join(' | ');
    assert.ok(missing.includes(canonical), `--${spelling} must be reported as ${canonical}: ${missing}`);
    assert.ok(
      correctionWarnings(plan).some((w) => w.includes(`--${spelling}`)),
      `--${spelling} must be corrected: ${JSON.stringify(plan.warnings)}`,
    );
    assert.ok(!missing.includes(spelling), `the body name must not reach the missing list: ${missing}`);
  }
  const contract = new Set([...FUNCTIONGRAPH_CREATE_REQUIRED, ...FUNCTIONGRAPH_CODE_SOURCE]);
  for (const [spelling, canonical] of Object.entries(cases)) {
    assert.equal(FUNCTIONGRAPH_CREATE_ALIASES[spelling], canonical);
    assert.ok(contract.has(canonical), `${spelling} must map onto a contract parameter, got ${canonical}`);
  }
});

test('planning a batch that creates the function and its trigger reports the serial dependency', () =>
  withSandboxHome(async () => {
    const planned = await callTool('huaweicloud_plan_manifest', {
      commands: [
        { args: createFunctionArgs(), note: 'create the probe function' },
        { args: timerTriggerArgs(`urn:fss:<region>:<project_id>:function:default:${FUNCTION_NAME}`), note: 'timer' },
      ],
    });
    assert.equal(planned.dependencyIssues.length, 1);
    assert.equal(planned.dependencyIssues[0].code, 'CREATE_FUNCTION_TRIGGER_BEFORE_URN');
    assert.equal(planned.dependencyIssues[0].index, 1);
    assert.equal(planned.safeToRun, false, 'an unrunnable batch must not be offered as approved');
    assert.ok(planned.note.includes('func_urn'));
  }));

test('a trigger planned with a placeholder URN alone is flagged', () =>
  withSandboxHome(async () => {
    const planned = await callTool('huaweicloud_plan_manifest', {
      commands: [{ args: argsFromExample(SERVICE_EXAMPLES.FUNCTIONGRAPH.createTrigger) }],
    });
    assert.equal(planned.dependencyIssues[0].code, 'PLACEHOLDER_FUNCTION_URN');
    assert.equal(planned.safeToRun, false);
  }));

test('the serial flow — create first, then the trigger with the returned URN — is clean', () =>
  withSandboxHome(async () => {
    const createStep = await callTool('huaweicloud_plan_manifest', {
      commands: [{ args: createFunctionArgs(), note: 'step 1: create the function' }],
    });
    assert.deepEqual(createStep.dependencyIssues, []);
    assert.equal(createStep.safeToRun, true);

    const triggerStep = await callTool('huaweicloud_plan_manifest', {
      commands: [{ args: timerTriggerArgs(FUNCTION_URN), note: 'step 2: timer on the created function' }],
    });
    assert.deepEqual(triggerStep.dependencyIssues, []);
    assert.equal(triggerStep.safeToRun, true);
    assert.ok(
      triggerStep.commands[0].command.includes(FUNCTION_URN),
      'the trigger echo must carry the URN of the function created in the previous step',
    );
  }));

test('running such a batch is rejected before any command executes', () =>
  withSandboxHome(async () => {
    const commands = [{ args: createFunctionArgs() }, { args: timerTriggerArgs('') }];
    const planned = await callTool('huaweicloud_plan_manifest', { commands });
    const refused = await callTool('huaweicloud_run_approved_manifest', {
      commands,
      approvalToken: planned.approvalToken,
      approvedByUser: true,
    });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.code, 'MANIFEST_DEPENDENCY_ORDER');
    assert.equal(refused.dependencyIssues[0].parameter, 'function_urn');
    assert.equal(refused.results, undefined, 'nothing may run when the batch is out of order');
  }));
