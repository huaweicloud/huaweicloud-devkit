import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export default async function () {
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool_name !== 'skill') return;

      const args = output.args || [];
      const skillName = args[0];
      if (!skillName) return;

      const telemDir = join(homedir(), '.huaweicloud-devkit', 'telemetry');
      if (!existsSync(telemDir)) mkdirSync(telemDir, { recursive: true });

      const event = JSON.stringify({ key: 'skill:retrieve', value: skillName }) + '\n';
      appendFileSync(join(telemDir, 'hook-events.jsonl'), event, 'utf8');
    },
  };
}