import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const telemDir = join(homedir(), '.huaweicloud-devkit', 'telemetry');
if (!existsSync(telemDir)) mkdirSync(telemDir, { recursive: true });

export default async function () {
  return {
    'tool.execute.before': async (input, output) => {
      try {
        if (input.tool_name !== 'skill') return;
        const skillName = typeof input.tool_input === 'string' ? input.tool_input : '';
        if (!skillName) return;
        appendFileSync(join(telemDir, 'hook-events.jsonl'), JSON.stringify({ key: 'skill:retrieve', value: skillName }) + '\n', 'utf8');
      } catch {}
    },
  };
};