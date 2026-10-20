# Windows SSH Login / Upload — Standard Paths

Windows has NO working `sshpass` (it is a Linux tool; Windows OpenSSH client does not ship it, and the
native `ssh` cannot take a password from stdin or env). Use the paths below instead of trial-and-error.
All facts verified on Windows (2026-10 activity reports: sshpass failures → 8-minute detour → paramiko).

## 0. First connection: `Connection refused` is usually just sshd not ready

On a fresh ECS, cloud-init finishes AFTER the instance reports ACTIVE. A first SSH attempt that gets
`Connection refused` / `timeout` is typically the sshd service not yet listening — do NOT debug the
security group or EIP on the first refusal. Retry with backoff first:

```bash
for i in 1 2 3 4 5; do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -i <key> root@<eip> 'echo ok' && break
  echo "retry $i: sshd may not be ready yet"; sleep 15
done
```

Only after all retries fail, treat it as a network problem (security group port 22 ingress, EIP binding).

## 0.1 代理出口 IP 陷阱：`api.ipify` 返回的不是真实直连出口（实测 #935 坑6）

本机配置了 HTTP/HTTPS 代理时，`api.ipify`、`ifconfig.me` 等检测服务返回的是**代理出口 IP** 而非真实直连出口 —— 安全组按这个错误 IP 放通 22 端口后 SSH 仍然超时（连接根本不走代理）。

Windows 检测**真实直连出口**必须绕过代理：

```powershell
# 真实直连出口（-NoProxy 绕过本机代理，实测确认）
Invoke-RestMethod -Uri "https://api.ipify.org" -NoProxy
# 对照（会返回代理出口，仅用于确认差异）：
Invoke-RestMethod -Uri "https://api.ipify.org"
```

放通规则用真实直连出口的 `/32` 精确规则（不要放通 `0.0.0.0/0`，风险规则也会拦截）：

```bash
hcloud VPC CreateSecurityGroupRule --security_group_rule.security_group_id=<sg-id> \
  --security_group_rule.direction=ingress --security_group_rule.port_range_min=22 \
  --security_group_rule.port_range_max=22 --security_group_rule.protocol=tcp \
  --security_group_rule.remote_ip_prefix=<真实直连出口IP>/32
```

SSH 超时时的完整诊断流程见下方 §5。

## 1. Login from Windows

```powershell
# Standard OpenSSH login (Windows 10+ ships OpenSSH client)
ssh -o StrictHostKeyChecking=accept-new -i C:\path\to\<key> root@<eip>
```

Key file permission note: Windows OpenSSH checks ACLs on the private key. If ssh warns
`UNPROTECTED PRIVATE KEY FILE`, fix with (PowerShell):

```powershell
icacls C:\path\to\<key> /inheritance:r /grant:r "$env:USERNAME:R"
```

Passphrase trap (from `references/create-instance.md` §5): a key generated with `-N '""'` in PowerShell
carries a LITERAL `""` passphrase — the server accepts the key but SSH still fails `Permission denied`.
If you hit that, strip the passphrase locally and retry (server side needs zero changes):

```powershell
ssh-keygen -p -f C:\path\to\<key>
# enter the old passphrase as "" (two quote characters), leave the new one empty
```

## 2. Password auth: sshpass does not exist on Windows — use paramiko

`sshpass` is unavailable on Windows OpenSSH; password-based automation must go through Python paramiko
(pip install paramiko):

```python
# upload + run commands via paramiko (Windows-safe password auth)
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('<eip>', username='root', password='<password>', timeout=15)
# upload
sftp = client.open_sftp()
sftp.put(r'C:\local\file.tar.gz', '/root/file.tar.gz')
sftp.close()
# run a command
_, stdout, stderr = client.exec_command('tar -xzf /root/file.tar.gz -C /root && echo OK')
print(stdout.read().decode(), stderr.read().decode())
client.close()
```

- `exec_command` is one-shot per call — chain commands with `&&` inside a single call for state.
- Never put the password in the conversation or shell history; pass it at runtime.

Key-based file upload from Windows (no paramiko needed): `scp` ships with Windows OpenSSH:

```powershell
scp -o StrictHostKeyChecking=accept-new -i C:\path\to\<key> C:\local\file root@<eip>:/root/
```

## 3. No SSH at all: cloud-init public-key injection (standard path)

KooCLI has no `ImportKeypair` operation, and `NovaCreateKeypair`'s returned `private_key` is masked
(redacted) by the tool pipeline — it cannot be recovered. The documented standard path is
**local keypair generation + cloud-init public-key injection** (no SSH needed at creation time):

1. Generate a keypair locally (per-shell forms and the PowerShell quote trap: `references/create-instance.md` §5)
2. Inject the PUBLIC key at creation via `--server.user_data` (base64 cloud-init):

   ```bash
   # user_data (must be base64-encoded when passed to CreateServers)
   #cloud-config
   ssh_authorized_keys:
     - <content of the local .pub file>
   ```

   ```bash
   user_data=$(base64 -w0 << 'EOF'
   #cloud-config
   ssh_authorized_keys:
     - <pub key content>
   EOF
   )
   hcloud ECS CreateServers ... --server.user_data=$user_data
   ```

3. After ACTIVE, SSH in with the matching private key (`ssh -i <key> root@<eip>`).

This path avoids `NovaCreateKeypair` entirely (no private_key masking problem) and works even when SCP
policies block SSH at first boot — see `references/create-instance.md` §Bootstrap for the full
user_data workflow (mirror sources, observability sentinels, first-boot-only semantics).

## 4. Quick reference

| Task (Windows)                             | Path                                                                |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Login                                      | `ssh -i <key> root@<eip>` (OpenSSH built-in)                        |
| First `Connection refused`                 | Retry 3-5x with 15s backoff — sshd not ready yet                    |
| Password automation                        | paramiko (`sshpass` unavailable on Windows)                         |
| File upload (key auth)                     | `scp -i <key> <local> root@<eip>:<path>`                            |
| File upload (password)                     | paramiko SFTP (`put`)                                               |
| No keypair yet                             | local `ssh-keygen` + cloud-init `ssh_authorized_keys` inject        |
| `Permission denied` but server accepts key | literal `""` passphrase from `-N '""'` — strip with `ssh-keygen -p` |
