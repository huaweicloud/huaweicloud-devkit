# ECS Troubleshooting

基于真实测试暴露的常见错误和诊断步骤。

## 错误码映射

| 错误                                    | 根因                            | 修复                                                                                                                                                               |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ecs.0005` flavor-image 不匹配          | 镜像虚拟化类型与规格不兼容      | 检查 image `__support_amd`/`__support_xen` 与 flavor `os_extra_specs`。BareMetal 镜像不兼容标准 ECS 规格                                                           |
| `[USE_ERROR]不正确的参数:imagetype`     | 参数名错误                      | KooCLI 使用双下划线前缀：`--__imagetype=gold`（不是 `--imagetype`）                                                                                                |
| `[USE_ERROR]不正确的参数:chargingMode`  | 参数路径错误                    | 计费模式参数路径：`--server.extendparam.chargingMode=postPaid`。不传默认按需付费                                                                                   |
| `[USE_ERROR]不正确的参数:__support_amd` | 参数无效                        | `IMS ListImages` 某些版本不支持此过滤。去掉该参数，使用 client-side 过滤                                                                                           |
| Cannot SSH                              | 安全组未开放22端口 或 未绑定EIP | 1) 添加入方向规则 tcp 22。2) `hcloud EIP AssociatePublicips --publicip_id=<id> --publicip.associate_instance_id=<port-id> --publicip.associate_instance_type=PORT` |
| Flavor unavailable                      | 区域不支持该规格                | `hcloud ECS ListFlavors --cli-region=<r>` 先查。不硬编码 s6/m6 等规格名                                                                                            |
| Insufficient resources                  | AZ 库存不足                     | 换规格、换 AZ、或等待资源释放                                                                                                                                      |
| `Ecs.0019` flavor 已下线                | 规格已下架                      | `hcloud ECS ListFlavors --cli-region=<r>` 查当前在售规格并切换替代规格（状态字段规则见 `references/flavors.md`）                                                   |
| `Ecs.0319` 可用区容量不足               | 目标 AZ 库存售罄                | 更换可用区或更换规格后重试                                                                                                                                         |
| `Ecs.0067` 余额受限                     | 现金余额不足/历史欠费           | 查 BSS 现金余额并充值（`hcloud BSS ShowCustomerAccountBalances --cli-region=cn-north-1`）；代金券不参与按量付费下单风控，历史欠费需先结清                          |
| `KPS.9004` 密钥对创建受限               | 现金余额不足/历史欠费           | 同上：查 BSS 现金余额并充值 + 历史欠费结清后重试 `hcloud ECS NovaCreateKeypair`                                                                                    |
| AuthFailure                             | AK/SK 过期或无效                | `npx huaweicloud-devkit auth init` 重新配置统一凭据                                                                                                                |

## 创建失败诊断流程

1. 运行 `hcloud ECS ListFlavors` — 确认规格在目标区域可用
2. 运行 `hcloud IMS ListImages --__imagetype=gold --limit=20` — 确认可用的公共镜像
3. 交叉检查：flavor `os_extra_specs` 中的虚拟化类型 vs image 的 `__support_*` 属性
4. 运行 `hcloud VPC ListVpcs` / `ListSubnets` — 确认 VPC 和子网存在
5. 运行 `hcloud ECS NovaListAvailabilityZones` — 确认 AZ 可用
6. 创建后：`hcloud ECS ListServersDetails --server_id=<id>` 检查状态
7. 状态 `BUILD` → 等待。`ERROR` → 查看 job_id 详情

## 镜像查询正确姿势

```bash
# 正确：双下划线前缀
hcloud IMS ListImages --cli-region=<r> --__imagetype=gold --__isregistered=true --limit=20

# 按需过滤（如果参数支持）
# --virtual_env_type=FusionCompute  排除 BareMetal
# 不支持的参数不要传，用 client-side 过滤
```

## EulerOS 3.0 firewalld：安全组放行后仍不可达（实测 #935 报告4 问题2）

EulerOS 3.0 镜像内置 firewalld 且**默认拒绝 SSH 入站** —— 安全组已放行 22 端口后 SSH 仍超时，是实例内防火墙在拦截，不是安全组问题。修复：

```bash
# 镜像内放行 SSH（SSH 可用时）
firewall-cmd --permanent --add-service=ssh && firewall-cmd --reload
```

或改用 cloud-init user_data 自动部署（创建时写入，无需 SSH）：

```bash
# user_data（base64 后传 CreateServers）
#cloud-config
runcmd:
  - firewall-cmd --permanent --add-service=ssh
  - firewall-cmd --reload
```

## SSH 失败自动诊断流程（实测 #935 报告3 问题5）

SSH 超时时按序排查，先比对**本机真实直连出口 IP** 与安全组 22 端口规则的源 IP 是否一致：

1. 查本机**真实直连出口**：Windows 用 `Invoke-RestMethod -Uri "https://api.ipify.org" -NoProxy`（配置了代理时，不带 `-NoProxy` 的 `api.ipify` 返回的是代理出口，不是真实直连出口 —— 详见 `references/windows-ssh.md` §0.1）；Linux 用 `curl --noproxy '*' https://api.ipify.org`
2. 查安全组 22 端口规则的源 IP：`hcloud VPC ListSecurityGroupRules --security_group_id=<sg-id> --cli-region=<r>`
3. 两者不一致 → 更新规则源 IP 为真实直连出口的 `/32` 精确规则
4. 一致仍超时 → 查 EIP 绑定（`hcloud EIP ListPublicips`）→ 再查实例内防火墙（上方 EulerOS firewalld 小节）
5. 全部正常才考虑重装/重建

## 密钥对 vs 密码

| 方式                       | 安全  | 建议                                               |
| -------------------------- | ----- | -------------------------------------------------- |
| `--server.key_name=<name>` | ✅ 高 | **推荐**。先 `hcloud DEW CreateKeypair` 创建密钥对 |
| `--server.adminPass=<pw>`  | ❌ 低 | 密码明文进入 shell 历史。仅测试用                  |

密码要求：8-26 字符，含大写 + 小写 + 数字 + 特殊字符。

## 删除注意事项

- `--delete_publicip` 默认 false — EIP 不随实例删除，继续计费
- `--delete_volume` 默认 false — 系统盘不随实例删除
- 数据盘默认随实例删除（与系统盘行为相反）

## 删除完成验证：轮询操作纠正（实测 #935 坑8）

`NovaShowJob` 操作**不存在**（KooCLI 与 ECS API 均无此操作，删除轮询用它必然报错）。删除 ECS 后的正确验证方式：

```bash
# 删除 ECS（异步任务）
hcloud ECS DeleteServers --servers.1.id=<instance-id> --delete_publicip=true --delete_volume=true

# 轮询直至目标实例状态为 DELETED（或列表查询 404）
for i in 1 2 3 4 5 6; do
  hcloud ECS ListServersDetails --cli-region=<r> --limit=50 | grep -q "<instance-id>" || { echo "DELETED (not in list)"; break; }
  hcloud ECS ListServersDetails --cli-region=<r> --id=<instance-id> | grep -q '"DELETED"' && { echo "DELETED"; break; }
  echo "still deleting..."; sleep 10
done
```

列表查询返回 404 或实例不在列表中，同样视为删除完成。
