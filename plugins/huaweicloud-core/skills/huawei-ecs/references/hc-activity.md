# HC活动 ECS + Nginx/Node.js 部署后端服务

## 目标

在华为云 cn-north-4 区域，按量付费购买 ECS，部署后端代码仓的后端服务。

## 前置条件

- 后端代码仓 git 地址
- 账户已有默认 VPC 和子网(Agent 自动查询)

## 流程

1. 查询 VPC/子网，创建安全组，放通 SSH(22)仅本机IP、HTTP(80)全网
2. 查询镜像(推荐 HCE 2.0)和规格，直接购买1核2G
3. 创建 keypair，创建按量付费 ECS(系统盘 SSD 40GB)，轮询等待 ACTIVE
4. 创建 5_bgp 按流量计费 EIP，绑定到 ECS 端口
5. SSH 登录，安装 Node.js 18，git clone 代码仓，npm install
6. Nginx反向代理:80->:3000
7. 验证 /hc-activity/api/title 和 /hc-activity/health

## 注意事项

- 后端3000仅监听回环
- Nginx修改后 nginx -t 再 reload
- 按量付费停机仍计费
- 删除实例时 --delete_publicip=true --delete_volume=true

## 作品提交链接（api_link）校验规则（实测 #935 报告2 问题4/5、报告4 问题3）

① 提交路径必须包含 `/hc-activity/` 与 `index.html`，否则服务端返回 400 `OPENSERVICE_PARAM_ERROR 作品链接格式不合法`。

② 客户端正则与服务端规则存在不一致（客户端较宽松）—— 提交前以服务端严格规则为准做本地校验，避免提交才被拒：

```bash
# 本地预校验（服务端严格规则：路径须含 /hc-activity/ 且指向 index.html）
case "$LINK" in
  */hc-activity/*index.html) echo "OK: passes server-side validation" ;;
  *) echo "INVALID: link must contain /hc-activity/ and index.html (server returns OPENSERVICE_PARAM_ERROR)" ;;
esac
```

③ 返回「**作品链接无效**」时区分语义：可能为服务端尚未探活成功（隧道/站点刚上线，服务端探测未完成），并非格式错误 —— 先确认隧道可达（curl 实测 HTTP 200），然后等 1-2 分钟后重试，不要立即改链接格式。
