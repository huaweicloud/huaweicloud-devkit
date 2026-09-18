import { readFileSync } from 'node:fs';

import { classifyTextCommand } from '../src/safety-policy.mjs';

const DENY_PREFIX = 'Huawei Cloud safety hook blocked this action: ';

function commandText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (toolInput && typeof toolInput === 'object') {
    const values = [];
    for (const key of ['command', 'cmd', 'script', 'args', 'arguments']) {
      const value = toolInput[key];
      if (Array.isArray(value)) values.push(value.map(String).join(' '));
      else if (value !== undefined && value !== null) values.push(String(value));
    }
    if (values.length > 0) return values.join('\n');
    return JSON.stringify(toolInput);
  }
  return JSON.stringify(toolInput);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_PREFIX + reason,
      },
    }) + '\n',
  );
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = readStdin();
  if (!input.trim()) {
    deny('empty stdin received; safety hook cannot evaluate an empty request.');
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    deny('malformed JSON input; safety hook cannot evaluate an unparseable request.');
    return;
  }

  const text = commandText(data.tool_input ?? {});
  const result = classifyTextCommand(text);
  if (result.decision === 'deny') deny(result.reason);
}

main();
