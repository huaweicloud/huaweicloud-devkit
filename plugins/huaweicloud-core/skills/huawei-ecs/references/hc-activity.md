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
