// #815 / D3-S6 — the FunctionGraph timer scenario failed because the
// CreateFunction example named only the operation, so the agent assembled the
// request body itself and the API rejected the call on a mandatory field that
// the releases named differently (function_name, code.filename, code.zip_file).
// These cases pin the v2 side of the fix: the example carries the whole minimal
// parameter set, the pre-execution check reports one canonical field name
// whatever spelling the caller used, and a trigger with no real URN says which
// step owes it instead of failing with the function it depends on.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FUNCTIONGRAPH_CODE_SOURCE,
  FUNCTIONGRAPH_CREATE_ALIASES,
  FUNCTIONGRAPH_CREATE_REQUIRED,
  planHcloudCommand,
  type HcloudPlan,
} from '../plugins/huaweicloud-core/src/hcloud-plan.ts';
import { SERVICE_EXAMPLES } from '../plugins/huaweicloud-core/src/packs/huaweicloud-cli/tools.ts';

const FUNCTION_NAME = 'new-fg-rds-probe';
const FUNCTION_URN = `urn:fss:cn-north-4:0000000000000000000000000000000a:function:default:${FUNCTION_NAME}:latest`;

// Plans mint approval tokens by default; these cases only read the pre-execution
// verdict, so the token face stays off and no state dir is touched.
function plan(args: string[]) {
  return planHcloudCommand(args, { mintApprovalToken: false });
}

function argsFromExample(example: string): string[] {
  return example.split(/\s+/).filter(Boolean);
}

function flagsOf(args: string[]): string[] {
  return args.filter((arg) => String(arg).startsWith('--')).map((arg) => arg.slice(2).split('=')[0] ?? '');
}

function createFunctionArgs(): string[] {
  return [
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
}

function timerTriggerArgs(urn: string): string[] {
  return [
    'FunctionGraph',
    'CreateFunctionTrigger',
    `--function_urn=${urn}`,
    '--trigger_type_code=TIMER',
    '--event_type_code=MessageCreated',
    '--trigger_status=ACTIVE',
    '--event_data.name=new-fg-rds-probe-timer',
    '--event_data.schedule_type=Rate',
    '--event_data.schedule=1m',
  ];
}

const missingWarnings = (warnings: HcloudPlan['warnings']) =>
  warnings.filter((w) => String(w).startsWith('Missing required parameters:'));
const correctionWarnings = (warnings: HcloudPlan['warnings']) =>
  warnings.filter((w) => String(w).includes('is a request-body field name, not a KooCLI parameter'));
const urnWarnings = (warnings: HcloudPlan['warnings']) =>
  warnings.filter((w) => String(w).includes('CreateFunctionTrigger needs the real --function_urn'));

test('the FunctionGraph create example carries the whole minimal parameter set', () => {
  const example = SERVICE_EXAMPLES.FUNCTIONGRAPH?.create ?? '';
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
  const planned = plan(createFunctionArgs());
  assert.deepEqual(missingWarnings(planned.warnings), []);
  assert.deepEqual(correctionWarnings(planned.warnings), []);
});

test('the example command itself passes the pre-execution check', () => {
  const example = SERVICE_EXAMPLES.FUNCTIONGRAPH?.create ?? '';
  const planned = plan(argsFromExample(example));
  assert.deepEqual(missingWarnings(planned.warnings), []);
});

test('a create call missing the code payload names the canonical code flag', () => {
  const args = createFunctionArgs().filter((arg) => !arg.startsWith('--func_code.file'));
  const [missing] = missingWarnings(plan(args).warnings);
  assert.ok(missing, 'a code-less create must be flagged before the API call');
  assert.ok(String(missing).includes('func_code.file'), `canonical code flag expected, got: ${String(missing)}`);
});

test('body-field spellings are reported under the canonical flag, not the spelling used', () => {
  const reported = ['function_name', 'funcname'].map((spelling) => {
    const args = createFunctionArgs().map((arg) =>
      arg.startsWith('--func_name=') ? arg.replace('--func_name', `--${spelling}`) : arg,
    );
    const planned = plan(args);
    assert.ok(
      correctionWarnings(planned.warnings).some(
        (w) => String(w).includes(`--${spelling}`) && String(w).includes('--func_name'),
      ),
      `the plan must correct --${spelling} to --func_name: ${JSON.stringify(planned.warnings)}`,
    );
    return missingWarnings(planned.warnings).join(' | ');
  });
  // One defect, one field name: the missing list is identical whatever spelling
  // the caller chose, so the error no longer floats across versions.
  assert.equal(new Set(reported).size, 1, `canonical report must not float: ${JSON.stringify(reported)}`);
  assert.ok(reported[0]?.includes('func_name'), `canonical name expected: ${String(reported[0])}`);
  assert.ok(!reported[0]?.includes('function_name'), `body name must not leak: ${String(reported[0])}`);
});

test('code payload body-field spellings map onto the canonical code flag', () => {
  const cases: Record<string, string> = { 'code.filename': 'code_filename', 'code.zip_file': 'func_code.file' };
  for (const [spelling, canonical] of Object.entries(cases)) {
    const args = createFunctionArgs()
      .filter((arg) => !arg.startsWith('--func_code.file'))
      .concat(`--${spelling}=function.zip`);
    const planned = plan(args);
    const missing = missingWarnings(planned.warnings).join(' | ');
    assert.ok(missing.includes(canonical), `--${spelling} must be reported as ${canonical}: ${missing}`);
    assert.ok(
      correctionWarnings(planned.warnings).some((w) => String(w).includes(`--${spelling}`)),
      `--${spelling} must be corrected: ${JSON.stringify(planned.warnings)}`,
    );
    assert.ok(!missing.includes(spelling), `the body name must not reach the missing list: ${missing}`);
    assert.equal(FUNCTIONGRAPH_CREATE_ALIASES[spelling], canonical);
    assert.ok(
      new Set([...FUNCTIONGRAPH_CREATE_REQUIRED, ...FUNCTIONGRAPH_CODE_SOURCE]).has(canonical),
      `${spelling} must map onto a contract parameter, got ${canonical}`,
    );
  }
});

test('a trigger planned with a placeholder URN says which step owes the URN', () => {
  const placeholder = plan(timerTriggerArgs('urn:fss:<region>:<project_id>:function:default:new-fg-rds-probe'));
  const [warning] = urnWarnings(placeholder.warnings);
  assert.ok(warning, `a placeholder URN must be called out: ${JSON.stringify(placeholder.warnings)}`);
  assert.ok(String(warning).includes('run CreateFunction first'));
  assert.ok(String(warning).includes('func_urn'));

  const fromExample = plan(argsFromExample(SERVICE_EXAMPLES.FUNCTIONGRAPH?.create ?? ''));
  assert.deepEqual(urnWarnings(fromExample.warnings), [], 'the create example is not a trigger');

  const missingUrn = plan(['FunctionGraph', 'CreateFunctionTrigger', '--trigger_type_code=TIMER']);
  assert.ok(
    missingUrn.warnings.some((w) => String(w).includes('it is missing')),
    'an absent URN must be named as missing',
  );
});

test('the serial flow — create first, then the trigger with the returned URN — is clean', () => {
  const createStep = plan(createFunctionArgs());
  assert.deepEqual(missingWarnings(createStep.warnings), []);
  assert.deepEqual(urnWarnings(createStep.warnings), []);

  const triggerStep = plan(timerTriggerArgs(FUNCTION_URN));
  assert.deepEqual(missingWarnings(triggerStep.warnings), []);
  assert.deepEqual(urnWarnings(triggerStep.warnings), []);
  assert.ok(
    triggerStep.command.includes(FUNCTION_URN),
    'the trigger echo must carry the URN of the function created in the previous step',
  );
});
