import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function writeEvent(skillName) {
  const telemDir = join(homedir(), '.huaweicloud-devkit', 'telemetry');
  if (!existsSync(telemDir)) mkdirSync(telemDir, { recursive: true });
  const event = JSON.stringify({ key: 'skill:retrieve', value: skillName }) + '\n';
  appendFileSync(join(telemDir, 'hook-events.jsonl'), event, 'utf8');
}

export default async function () {
  return {
    'tool.execute.before': async (input) => {
      try {
        if (input.tool_name !== 'skill') return;
        const skillName = input.tool_input;
        if (typeof skillName === 'string' && skillName) {
          writeEvent(skillName);
        }
      } catch {}
    },
  };
}