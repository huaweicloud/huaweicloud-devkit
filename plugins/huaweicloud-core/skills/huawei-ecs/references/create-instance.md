# Create ECS Instance SOP

**Before executing any command: If MCP tools are not available** (new session after install), restart your session or use hcloud CLI directly with caution. Commands using adminPass/password WILL appear in shell history — prefer key_name.

## 1. Discover flavors

hcloud ECS ListFlavors --cli-region=<region> --cli-output=json
Filter for `os_extra_specs.cond:operation:status == normal` — most results are abandoned. See references/flavors.md.

## 2. Find availability zones

hcloud ECS NovaListAvailabilityZones --cli-region=<region>

## 3. Find image

```bash
# Broad search — specific names may return empty in some regions
hcloud IMS ListImages --cli-region=<region> --__imagetype=gold --__isregistered=true --limit=20
```

If searching by name (e.g. --name="Ubuntu") returns empty: use broad search without name filter, pick from results. Some regions only offer Huawei Cloud EulerOS (HCE).

Common images (verify live per region):

| Image            | Region     | ID                                   |
| ---------------- | ---------- | ------------------------------------ |
| HCE 2.0 Standard | cn-north-4 | 7d940784-ac0a-425f-b3fa-8478f1a1df70 |
| Ubuntu 22.04     | Query live | Query live                           |
| CentOS 8.2       | Query live | Query live                           |

## 4. Verify or create VPC/subnet

hcloud VPC ListVpcs --cli-region=<region>
hcloud VPC ListSubnets --vpc_id=<vpc-id> --cli-region=<region>
If no VPC/subnet exists: load `huawei-vpc` skill → create VPC → create subnet (with DNS) → create security group → return here.

**子网 DNS 前置修复（实测 #935 坑4）**：模板/预置子网的 `dnsList` 可能为空 —— 这会让 cloud-init 域名解析与 yum/dnf 安装**静默失败**（表现为下载/安装卡死且无明确报错，或 `Could not resolve host`）。创建 ECS 前先检查并补充华为云内网 DNS：

```bash
hcloud VPC ShowSubnet --subnet_id=<subnet-id> --cli-region=<region>   # 查看 dnsList
# dnsList 为空（或缺少内网 DNS）时先修复再建实例：
hcloud VPC UpdateSubnet --subnet_id=<subnet-id> --subnet.dnsList.1=100.125.1.250 --subnet.dnsList.2=100.125.129.250
```

`100.125.1.250` / `100.125.129.250` 是华为云内网 DNS（各区域通用）。实例内自救兜底见下方 user_data 模板的「DNS 兜底」注释，但**修复子网 DNS 是唯一能让 cloud-init 首次开机就正常解析的路径**（user_data 只在 first boot 执行，错过即需人工补救）。

## 5. Create keypair (recommended over adminPass)

**MCP 环境下必须用"本地生成 + 导入"流程**——`NovaCreateKeypair` 返回的 `private_key` 会被 MCP 脱敏管道替换为 `<redacted>`，而私钥仅此一次机会，读不到即作废：

```bash
# 1. 本地生成 — bash / Git Bash / WSL（无 passphrase）
ssh-keygen -t rsa -b 2048 -f ./<name> -N ''
```

```powershell
# 1. 本地生成 — Windows PowerShell（无 passphrase，实测验证的写法）
# ⚠️ 引号陷阱：-N '""' 会把字面量 "" 设为私钥 passphrase（实测确认），后续 SSH 症状极具误导性：
#    ECS 已 ACTIVE、22 端口可达、服务端日志显示 "accepts key"，签名后仍 Permission denied ——
#    服务端接受了密钥却拒绝，排查路径反直觉。本地剥掉 passphrase（ssh-keygen -p）立即恢复，服务器侧零改动。
# 正确写法：--% 停止解析符 + -N ""（PowerShell 会丢弃空字符串参数，-N '' 直接报
# "option requires an argument -- N"；--% 让该行剩余部分按 cmd 规则原样传递，"" 由 CRT 解析为空串）。
# 注意：--% 之后到行尾全部原样传递 —— 该行不能再跟任何其他命令或注释。
ssh-keygen --% -t rsa -b 2048 -f .\<name> -N ""
```

```bash
# 2. 导入公钥
hcloud ECS NovaCreateKeypair --keypair.name=<name> --keypair.public_key=<本地 .pub 文件内容>
# 3. 使用私钥文件 ./<name> 连接实例
```

> **陷阱**：删除密钥对的参数是 `--keypair_name=<name>`（path 风格），不是 `--keypair.name=<name>`（body 风格），混用报 USE_ERROR。

Password alternative:

- adminPass: 8-26 chars, must have uppercase + lowercase + digit + special char
- Passwords appear ONCE in creation output and are not retrievable
- Passwords are logged in shell history — this is a security risk

## 6. Create instance

hcloud ECS CreateServers --cli-region=<region> --server.name=<name> --server.flavorRef=<flavor-id> --server.imageRef=<image-id> --server.nics.1.subnet_id=<subnet-id> --server.root_volume.volumetype=<type> --server.root_volume.size=<minsize> --server.vpcid=<vpc-id> --server.availability_zone=<az> --server.key_name=<keypair-name> --server.count=1

### Bootstrap with user_data (cloud-init)

Use `--server.user_data` to run a cloud-init script at first boot. The value must be **base64-encoded**. This is also the recommended bootstrap path when SCP policies block SSH access — user_data serves as the full deployment path, no SSH needed.

**中国区镜像源强制规则**（实测：`deb.nodesource.com` 从北京四不可达，cloud-init 全链失败）：

```bash
#!/bin/bash
set -eux
# Node: 用华为云镜像二进制直装，固定小版本，禁用 NodeSource/curl Nodesource 脚本
# ⚠️ ARCH 必须与实例架构一致：kc1/kc2 等鲲鹏 = arm64；s6/s7/c7 等 x86 = x64
NODE_VERSION=v22.14.0
ARCH=arm64   # x86 实例改为 x64
curl -fsSL "https://mirrors.huaweicloud.com/nodejs/${NODE_VERSION}/node-${NODE_VERSION}-linux-${ARCH}.tar.xz" -o /tmp/node.tar.xz
mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
export PATH=/usr/local/lib/nodejs/node-${NODE_VERSION}-linux-${ARCH}/bin:$PATH
ln -sf /usr/local/lib/nodejs/node-${NODE_VERSION}-linux-${ARCH}/bin/{node,npm,npx} /usr/local/bin/
# npm registry 指向华为云
npm config set registry https://repo.huaweicloud.com/repository/npm/
# DNS 兜底（子网 dnsList 缺失时自救）
grep -q 100.125.0.20 /etc/resolv.conf || echo "nameserver 100.125.0.20" >> /etc/resolv.conf
```

**可观测性模板**（实测教训：cloud-init 失败后无感知、固定 sleep 空等 ≈8 分钟）：

```bash
# 每阶段落 sentinel，收尾打标记；agent 侧轮询标记而非固定 sleep
touch /var/log/kit-step1-deps-done
# ... 构建完成后：
touch /var/log/kit-deploy-done   # ← agent 轮询此文件出现即成功
# 失败时：cloud-init status --long + /var/log/cloud-init-output.log 定位
```

> **SSR/Next.js 项目强烈推荐"本地构建 + 上传产物"**（next standalone / `.next` + node_modules），服务器零构建可省 ~20 分钟且绕开服务器侧依赖解析风险。必须服务器构建时：先本地 `npm install` 验证 lockfile 再上传；已知坏组合黑名单——`isomorphic-dompurify@^2` 场景加 `overrides: {"html-encoding-sniffer":"4.0.0","jsdom":"25.0.1"}`（最新 jsdom→cssstyle→@csstools 链全 ESM-only，Next 14 构建期 CJS require 必挂，首个 `ERR_REQUIRE_ESM` 即跑 `npm ls <包>` 查依赖树，不要盲目重装）。

```bash
# Encode the script
user_data=$(cat << 'SCRIPT' | base64
#!/bin/bash
# Your bootstrap commands here.
# Output logs: /var/log/cloud-init-output.log
SCRIPT
)

hcloud ECS CreateServers ... --server.user_data=$user_data
```

#### Large user_data: pass via JSON file, do NOT abandon the MCP channel

The inline form above works only while the base64 blob fits the tool-call parameter limit (a few KB). The API itself accepts user_data up to **32KB before encoding** (`--server.user_data` in `hcloud ECS CreateServers --help`) — so a full bootstrap script (22KB base64 observed in the wild) is well within the API limit but **cannot be handed through a single MCP tool call**. When that happens, keep the MCP approval channel (plan → approve → run) and move the parameters to a local JSON file instead:

```bash
# 1. Generate the API parameter skeleton (writes a JSON file into the CURRENT directory):
hcloud ECS CreateServers --skeleton
#    -> ECS_CreateServers_<region>-<timestamp>.json, structured as header / path / body.
#    user_data lives at body.server.user_data (base64-encoded, same as inline).

# 2. Fill in the real values (name/flavorRef/imageRef/nics/... and body.server.user_data),
#    keep only the fields you actually use, then execute with the file:

hcloud ECS CreateServers --cli-region=<region> --cli-jsonInput=./ECS_CreateServers_<region>-<timestamp>.json

# 3. Optional pre-flight: --dryrun validates and prints the request payload WITHOUT creating anything:
hcloud ECS CreateServers --cli-region=<region> --cli-jsonInput=./<file>.json --dryrun
```

`--cli-jsonInput` / `--skeleton` / `--dryrun` are **global flags — they are NOT listed in operation-level `--help` output** (only in `hcloud --help`), so agents routinely miss them.

> **Anti-pattern (observed in the wild, #964)**: when the base64 blob exceeded the tool parameter limit, the agent dropped the MCP tools entirely and ran `hcloud` directly in a shell — which also silently bypassed the plan → approve → run approval layer. The JSON-file path above keeps oversized parameters on the approved channel. Never abandon the MCP wrapper just because one parameter is too long.
>
> **Skeleton side effect**: `--skeleton` writes its JSON file to the current working directory (it does not print to stdout). Clean it up or keep it as the record of what was created.

The security and recovery notes below apply to user_data in general (inline or JSON-file form):

> **Security**: Never embed secrets (passwords, AK/SK, tokens) in user_data. It is stored unencrypted and readable from within the instance via IMDS. Fetch secrets at boot from DEW/CSMS instead.
>
> **Debugging**: If the script didn't run, check `/var/log/cloud-init-output.log` on the instance.
>
> **Recovery after failure**: user_data only executes on **first boot**. Restarting the instance will NOT re-run user_data scripts. If cloud-init fails (e.g., DNS missing → `yum`/`apt` cannot resolve repos):
>
> 1. Fix the root cause (e.g., update subnet DNS via `VPC UpdateSubnet`)
> 2. Either: SSH into the instance and run the setup commands manually (see `huawei-ecs` → SSH Connection Verification → Running Commands Inside the Instance)
> 3. Or: Delete the instance and recreate with corrected user_data (fresh boot)

### Update site content on an already-running instance (no rebuild)

user_data/cloud-init 方式**仅适用于创建时写入** —— 已运行实例更新站点内容不要重建实例，直接上传 + reload：

```bash
# 上传新产物（Windows 路径：references/windows-ssh.md §2）
scp -i <key> ./dist.tar.gz root@<eip>:/root/
# 或 rsync（增量，仅传变化文件）
rsync -avz --delete -e "ssh -i <key>" ./dist/ root@<eip>:/var/www/site/

# SSH 内解压并热加载 nginx（无需重建实例）
ssh -i <key> root@<eip> 'tar -xzf /root/dist.tar.gz -C /var/www/site/ && nginx -t && nginx -s reload'
```

要点：`nginx -s reload` 热加载配置与静态内容，连接不断；`nginx -t` 先验证配置再 reload，避免 reload 一个坏配置。Node 应用则重启进程（`pm2 reload` 或 kill + nohup 重启）。

## 7. EIP (two methods)

### Method A: Inline with CreateServers (Recommended)

Add EIP parameters to the `CreateServers` command in step 6:

```bash
hcloud ECS CreateServers \
  --server.publicip.eip.iptype=<type> \
  --server.publicip.eip.bandwidth.sharetype=<share-type> \
  --server.publicip.eip.bandwidth.size=<size> \
  --server.publicip.eip.bandwidth.chargemode=traffic \
  ...
```

> **Trap**: Parameter names differ from `EIP CreatePublicip`. Use `iptype` (not `type`), `sharetype` (not `share_type`), and `chargemode` (not `charging_mode`). Always verify with `hcloud ECS CreateServers --help`.

### Method B: Create and bind separately

hcloud EIP CreatePublicip --publicip.type=<type> --bandwidth.size=<size> --bandwidth.share_type=<share-type> --bandwidth.name=<name>

```bash
# Get the ECS network port ID
hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id>
# → addresses.<vpc-id>[].OS-EXT-IPS:port_id

# Bind EIP via port
hcloud EIP AssociatePublicips --publicip_id=<eip-id> --publicip.associate_instance_id=<port-id> --publicip.associate_instance_type=PORT
```

## 8. Verify

ECS creation is asynchronous. Wait times vary widely (20s to 3min). Status transitions: `BUILD` → `ACTIVE` (or `ERROR`). Never use fixed sleep — poll actively:

```bash
for i in $(seq 1 30); do
  status=$(hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id> --cli-output=json | jq -r '.servers[0].status')
  if [ "$status" = "ACTIVE" ]; then break; fi
  if [ "$status" = "ERROR" ]; then echo "Creation failed"; exit 1; fi
  sleep 10
done
```

- Poll interval: 10 seconds
- Maximum wait: 5 minutes (30 iterations)
- After ACTIVE, confirm once more: `hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id>`

### Verify HTTP accessibility (if EIP bound)

```bash
# Get the EIP address from instance details
hcloud ECS ListServersDetails --cli-region=<region> --server_id=<instance-id>
# → addresses.<vpc-id>[].OS-EXT-IPS:addr

curl http://<eip-address>
# Expected: HTTP 200 (if port 80 open and web server installed)

## 9. Delete instance (with cleanup)
hcloud ECS DeleteServers --servers.1.id=<instance-id> --delete_publicip=true --delete_volume=true
Warning: --delete_publicip and --delete_volume default to false. Set to true to avoid orphaned charges.

## Constraints
- Name: 1-64 chars, letters/digits/hyphens
- Flavor: must be available in target region — always ListFlavors first
- Root volume: SSD 40GB min
- Keypair is safer than adminPass (passwords leak into shell history)
```
