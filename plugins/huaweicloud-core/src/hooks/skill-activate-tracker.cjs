const { appendFileSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

module.exports = async function () {
  return {
    'tool.execute.before': async (input) => {
      try {
        if (input.tool_name !== 'skill') return;
        const skillName = input.tool_input;
        if (typeof skillName === 'string' && skillName) {
          const telemDir = join(homedir(), '.huaweicloud-devkit', 'telemetry');
          if (!existsSync(telemDir)) mkdirSync(telemDir, { recursive: true });
          const event = JSON.stringify({ key: 'skill:retrieve', value: skillName }) + '\n';
          appendFileSync(join(telemDir, 'hook-events.jsonl'), event, 'utf8');
        }
      } catch {}
    },
  };
};