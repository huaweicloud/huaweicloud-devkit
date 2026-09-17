# HC活动 ECS + Nginx/Node.js 部署后端服务

## 目标

在华为云 cn-north-4 区域，按量付费购买 ECS，部署后端代码仓的后端服务。

## 前置条件

- 后端代码仓 git 地址
- 账户已有默认 VPC 和子网(Agent 自动查询)

## 流程（默认单段 cloud-init，零 SSH 往返）

1. 查询 VPC/子网，创建安全组：HTTP(80) 全网；SSH(22) 仅本机 IP（仅排查备用——单段部署不依赖 SSH，出口 IP 拿不准时可先不开 SSH）
2. **容量预检前置**：查镜像(推荐 HCE 2.0)、规格后，先 `hcloud ECS ListFlavorSellPolicies --flavor_id=<id>` 取 `sell_status=available` 的 AZ，子网与该 AZ 对齐再下单（撞上 `Ecs.0319` 会浪费整轮 plan→run）
3. 创建按量付费 ECS(系统盘 SSD 40GB)，`--server.user_data=<base64 单段 cloud-init>`，单个 user_data 一步到位：装 Node → git clone 代码仓 → npm install → PM2 起 3000(仅回环) → Nginx 反代 80→3000 → `touch /var/log/kit-deploy-done` 哨兵
4. 创建 5_bgp 按流量计费 EIP，绑定到 ECS 端口
5. **轮询公网 health（零 SSH，取代固定 sleep）**：`curl -s -o /dev/null -w "%{http_code}" http://<eip>/hc-activity/health` 直到 2xx（上限 ~10min，10s 间隔）
6. 验证 /hc-activity/api/title 和 /hc-activity/health

> cloud-init 脚本细节（华为云镜像直装 Node、中国区镜像源、ARCH 判断、哨兵落法），见 `create-instance.md` §Bootstrap。失败排查：`/var/log/cloud-init-output.log`；user_data 仅首启动执行，改错需删实例重建（fresh boot）。
> 为什么单段：两段式「先装依赖再 SSH 配置」的中间态依赖 SSH 白名单与出口 IP，出口 IP 被代理/VPN 干扰（167.x vs 真实 117.x）是本场景最耗时的根因，单段 cloud-init 直接绕开它。

## 全链路诊断

前端沙箱 → ECS 后端的完整链路：**DevBridge 隧道 → 沙箱 proxy-server.js(:3002) → ECS Nginx(:80) → PM2 Node.js(:3000)**。任一段出错（PM2 未启动、Nginx 配置缺失、隧道过期）都应一键定位，而不是逐层 curl。

### 方案一：MCP 工具（沙箱内可达的跳点）

对隧道、沙箱代理、以及经代理可达的后端 URL，用 `huaweicloud_sandbox_diag_chain` 一次检测并输出每段状态码 + 延迟（ms）：

```json
{
  "hops": [
    { "name": "tunnel", "target": "<tunnel-url>" },
    { "name": "proxy", "target": "http://localhost:3002/health" },
    { "name": "ecs_backend", "target": "http://localhost:3002/hc-activity/health" }
  ]
}
```

结果含 `complete`、每个 hop 的 `status`/`statusCode`/`latencyMs`，以及 `firstFailure`（第一个断裂的跳点）。

### 方案二：shell 一键诊断函数（含 ECS 内部检查）

ECS 内部的 PM2/Nginx/回环端口无法从沙箱直接探测，需通过本机 SSH 检查。在沙箱内先定义并运行通用函数：

```bash
diag_chain() {
  for hop in "$@"; do
    IFS='|' read -r name url <<< "$hop"
    out=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 10 "$url" 2>/dev/null || echo "000 0.000")
    code=$(echo "$out" | awk '{print $1}'); t=$(echo "$out" | awk '{print $2}')
    case "$code" in 2*|3*) ok="PASS";; *) ok="FAIL";; esac
    echo "[$name] $ok http=$code latency=${t}s"
  done
}
diag_chain "tunnel|<tunnel-url>" "proxy|http://localhost:3002/health" "ecs_backend|http://localhost:3002/hc-activity/health"
```

ECS 侧检查（本机 SSH 执行）：

```bash
ssh -o StrictHostKeyChecking=accept-new -i <key> root@<eip> '
  echo "--- nginx->node ---";
  curl -s -o /dev/null -w "backend_local http=%{http_code} time=%{time_total}s\n" http://localhost:3000/hc-activity/health;
  echo "--- pm2 ---"; pm2 list;
  echo "--- nginx config ---"; nginx -t
'
```

## 注意事项

- 后端3000仅监听回环
- Nginx修改后 nginx -t 再 reload
- 按量付费停机仍计费
- 删除实例时 --delete_publicip=true --delete_volume=true
- 下单前必查 `ListFlavorSellPolicies` 选实际有货的 AZ，与子网 AZ 一致，避免 `Ecs.0319`
- 出口 IP 若需放白名单（仅本机访问某端口），先 `curl -4 --noproxy '*' https://api.ipify.org` 取直连 IP，勿用代理出口 IP
