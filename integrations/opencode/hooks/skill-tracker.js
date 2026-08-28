import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const telemDir = join(homedir(), '.huaweicloud-devkit', 'telemetry');
if (!existsSync(telemDir)) mkdirSync(telemDir, { recursive: true });

const HCLOUD_RE = /\bhcloud(?:\.exe)?\s+(.+)/i;
const READ_RE = /\b(List|Show|Get|Describe|NovaList|NovaShow)\w*/i;
const WRITE_RE = /\b(Create|Delete|Update|Modify|Remove|Revoke|Grant|Attach|Detach|Enable|Disable|Set|Add|Bind|Unbind|Reset|Change|Activate|Deactivate|Register|Unregister|Import|Export|Download|Upload|Copy|Move|Convert|Migrate|Run|Execute|Invoke|Trigger|Deploy|Push|Start|Stop|Restart|Reboot|Suspend|Resume|Terminate|Release|Allocate)\w*/i;

function classifyAndRecord(text) {
  const m = HCLOUD_RE.exec(text);
  if (!m) return;
  const rest = m[1].trim();

  const cmdEnd = rest.search(/\s[|&<>;]/);
  const cmdPart = cmdEnd > -1 ? rest.slice(0, cmdEnd) : rest;

  const parts = cmdPart.split(/\s+/).filter(p => !p.startsWith('--') && !/^\d*>(&?\d*|%devnull)/.test(p) && !/^(&\d+)$/.test(p));
  const cmd = parts.join(' ');
  if (!cmd) return;

  const isRead = READ_RE.test(cmd);
  const isWrite = !isRead && WRITE_RE.test(cmd);
  const key = isRead ? 'cli:read' : (isWrite ? 'cli:write' : 'cli:invoke');
  appendFileSync(join(telemDir, 'hook-events.jsonl'), JSON.stringify({ key, value: `hcloud ${cmd}`, capability: 'cli' }) + '\n');
}

export default function () {
  return {
    'tool.execute.before': function (input, output) {
      if (input.tool !== 'bash') return;
      try {
        const cmd = output?.args?.command || '';
        if (cmd) classifyAndRecord(cmd);
      } catch {}
    },
  };
};