# OBS Common Pitfalls

基于真实测试暴露的陷阱和避坑方法。

## OBS 命令格式陷阱

OBS 使用 **obsutil-style** 子命令，不是 API-style 操作名：

| 错误写法（API-style） | 正确写法（obsutil-style）                     |
| --------------------- | --------------------------------------------- |
| `OBS --help`          | `hcloud OBS help`（无 `--`，`help` 是子命令） |
| `OBS CreateBucket`    | `hcloud OBS mb obs://<bucket>`                |
| `OBS PutObject`       | `hcloud OBS cp <file> obs://<bucket>/`        |
| `OBS DeleteBucket`    | `hcloud OBS rm obs://<bucket> -r`             |
| `OBS ListBuckets`     | `hcloud OBS ls`                               |

## 独立凭证配置

KooCLI OBS 使用独立的凭证文件 `~/.obsutilconfig`，**不是** `~/.hcloud/config.json`。

```bash
# OBS 命令报 "Please set ak, sk and endpoint" 时运行：
hcloud OBS config -i
# 交互式输入：AK、SK、endpoint（如 obs.cn-north-4.myhuaweicloud.com）
# 这必须由用户在 agent 对话外手动执行
```

## 目录上传语义

`hcloud OBS cp <dir>/ obs://bucket/ -r` 将本地**文件夹名作为对象前缀**：

```
本地结构:
  devkit/
    index.html
    assets/app.js

上传后 OBS 结构:
  obs://bucket/devkit/index.html     ← 多了 devkit/ 前缀
  obs://bucket/devkit/assets/app.js

预期结构:
  obs://bucket/index.html
  obs://bucket/assets/app.js
```

**规避方法**：

1. 先 `-dryRun` 预览实际键名，再执行真实上传
2. 或先将本地目录重命名为目标前缀名，如 `mv devkit/ root/` 后上传 `root/`
3. 或使用 `-flat` 参数（如支持）

## 静态网站托管

KooCLI OBS **不支持** `SetBucketWebsite` 命令。配置静态网站托管需要：

1. **MCP 工具**: `huaweicloud_obs_set_website_config`（插件内置，AWS4 签名处理，action=set/get/delete，实测可用）
2. **REST API**: `PUT /?website` 到桶的 endpoint
3. **控制台**: OBS 控制台 → 桶 → 静态网站托管 → 开启

## Content-Disposition 强制下载陷阱（2022-01-01 后创建的桶）

**实测发现（2026-10，cn-north-4）**：2022 年 1 月 1 日之后创建的 OBS 桶，对象 **GET 响应被 OBS 强制注入 `Content-Disposition: attachment`**——浏览器访问 HTML 一律下载而不是渲染，静态网站托管端点（`<bucket>.obs-website.<region>.myhuaweicloud.com`）也不例外，与对象元数据无关。

| 请求方式                | 返回的 Content-Disposition   | 说明                       |
| ----------------------- | ---------------------------- | -------------------------- |
| GET（浏览器、在线预览） | `attachment`（OBS 强制注入） | 网页被下载，无法渲染       |
| HEAD                    | 元数据中的值（如 inline）    | 会误导诊断，不是浏览器行为 |

**避坑方法**：

1. **验证网页行为必须用 GET 直连**（`curl -s -D - -o /dev/null <url>`，Windows 下为 `-o NUL`；或浏览器）——HEAD 和代理层会给出假象
2. **官方解法**：绑定自定义域名接入 **CDN**，在"CDN 控制台 > 域名管理 > 高级设置 > HTTP header 配置"设置 `Content-Disposition: inline`（参见华为云 CDN 文档《如何在浏览器中在线预览 OBS 中的对象？》）
3. 跨云对照：阿里云 OSS 同样策略（Bucket 域名访问 HTML 强制下载，绑定自定义域名即可在线预览）

**对静态托管的结论**：2022 年后创建的桶，裸 OBS（含 obs-website 端点）**无法交付可渲染的 web 站点**；自定义域名 + CDN（+ header 配置 inline）是**必要条件**，不是增强项。

## obsutil 元数据大小写陷阱

`cp -meta=content-disposition:inline`（小写）会被存为用户自定义元数据 `x-amz-meta-content-disposition`，**不命中标准头**；标准 HTTP 头（Content-Type、Content-Disposition、Cache-Control 等）必须按标准大小写书写：

```bash
# 错误：存为 x-amz-meta-content-disposition，浏览器不识别
hcloud OBS cp index.html obs://<bucket>/ -meta=content-disposition:inline
# 正确：命中标准 Content-Disposition 头
hcloud OBS cp index.html obs://<bucket>/ -meta=Content-Disposition:inline
```

## 权限模型（三层）

| 层级          | 作用域      | 优先级 |
| ------------- | ----------- | ------ |
| IAM Policy    | 用户/用户组 | 最高   |
| Bucket Policy | 桶级        | 中     |
| ACL           | 对象级      | 最低   |

**关键规则**：三层中**最严格**的生效。Bucket Policy 设为 public-read，但 IAM deny 了 → 结果是 deny。

**静态网站场景**：必须同时设置桶级 AND 对象级 `-acl=public-read`，因为 ACL 不级联。

```bash
# 桶级
hcloud OBS chattri obs://<bucket> -acl=public-read
# 对象级（必须单独执行）
hcloud OBS chattri obs://<bucket>/index.html -acl=public-read
```

## 桶命名约束

- 全局唯一，所有用户共享命名空间
- 小写字母、数字、连字符
- 3-63 字符
- 不能以连字符开头或结尾
- 不能是 IP 地址格式

## 版本控制陷阱

- 开启后**无法关闭**，只能暂停
- 删除桶前必须清空所有版本和删除标记
- 版本存储按对象大小计费

## 安全注意事项

- MUST 默认阻止公网访问
- MUST 启用 HTTPS-only
- SHOULD 开启访问日志
- 预签名 URL 最大 7 天有效期
- AK/SK 绝对不能写入 Bucket Policy

## 浏览器直传（BrowserJS SDK）

使用 OBS BrowserJS SDK（`esdk-obs-browserjs` 3.25.6）从浏览器直传 OBS 时的已知陷阱。**共享 AK/SK 的完整客户端代码严禁出现在浏览器端**——浏览器直传只允许「服务端生成预签名 URL / 临时凭证 + 浏览器携带凭证直传」模式。

### p01 · CORS AllowedMethod 缺 HEAD → 探测请求被吞

**现象**：浏览器端 `listObjects` 一律失败，DevTools 只显示 `Network Error`，无任何 OBS 错误体——因为没有 CORS 头，浏览器直接吞掉了响应。

**根因**：BrowserJS SDK 3.25.6 默认开启签名协商（`isSignatureNegotiation=!0`），在发起 listObjects 前会先向桶发一个 `HEAD ?apiversion` 探测请求。若 CORS 规则的 AllowedMethod 不含 `HEAD`，这个预检/探测请求返回 403 `AccessForbidden` 且**响应不带 CORS 头**，浏览器按同源策略丢弃整个响应，最终只呈现 `Network Error`——真实错误（AccessForbidden）被完全掩盖。

**修复**：CORS 规则的 AllowedMethod 必须包含 `HEAD`（连同 GET/PUT/POST/DELETE，完整五方法见下文「CORS 配置」章节的 JSON/XML 模板）。

### p02 · `signature:'v4'` 被静默忽略

**现象**：构造客户端时传 `signature:'v4'`，但生成的请求/预签名仍是 V2 签名，且无任何警告。

**根因**：3.25.6 的 `initFactory` 未消费 `signature` 配置项，静默降级为默认 V2。想要 V4 预签名，必须手动注入 `signatureContext`：

```js
const client = new ObsClient({
  access_key_id: '<AK>', // 临时凭证场景用 STS 临时 AK
  secret_access_key: '<SK>',
  server: 'https://obs.<region>.myhuaweicloud.com',
  // signature: 'v4' 在 3.25.6 被静默忽略，不起作用 —— 见 p02
  signatureContext: {
    signature: 'v4',
    headerPrefix: 'X-Amz-',
    headerMetaPrefix: 'X-Amz-Meta-',
    authPrefix: 'AWS4-HMAC-SHA256',
  },
});
```

### p03 · 预签名 URL 的 token 参数大小写陷阱

**现象**：用临时凭证（STS token）生成 V4 预签名 URL，浏览器访问返回 403 `AccessDenied`。

**根因**：SDK 3.25.6 拼预签名 query 时把安全令牌参数拼成混合大小写 `X-Amz-security-token`，而 OBS 服务端对 query 参数名**大小写敏感**，只认小写 `x-amz-security-token`，大小写不匹配 → 403 `AccessDenied`。

**修复**：不要依赖 SDK 自动拼接 token，改为在生成预签名 URL 时以**小写**参数名手动传入 QueryParams：

```js
const { signedUrl } = await client.createSignedUrl({
  Method: 'PUT',
  Bucket: '<bucket>',
  Key: '<object-key>',
  Expires: 3600,
  Headers: { 'x-amz-acl': 'public-read' },
  QueryParams: {
    'x-amz-security-token': '<security-token>', // 必须小写！SDK 自动拼的是 X-Amz-security-token（见 p03）
  },
});
// 浏览器侧直接 fetch(signedUrl, { method: 'PUT', body: file })
```

### p04 · V4 头部签名在浏览器端不可用

**现象**：给浏览器端客户端配了 V4 signatureContext 后，listObjects / deleteObject 等头部鉴权请求全部 403。

**根因**：V4 头部签名依赖的派生/规范化逻辑在浏览器环境不完整（BrowserJS SDK 仅对**预签名 URL** 路径支持 V4）。

**修复**——双客户端分工：

- **列表/删除等 HTTP 头鉴权操作**：用 V2 头部签名客户端，并显式关闭签名协商（否则又踩 p01 的 HEAD 探测问题）：

```js
const v2Client = new ObsClient({
  access_key_id: '<AK>',
  secret_access_key: '<SK>',
  server: 'https://obs.<region>.myhuaweicloud.com',
  is_signature_negotiation: false, // 关闭协商，跳过 HEAD ?apiversion 探测（见 p01/p04）
});
await v2Client.listObjects({ Bucket: '<bucket>' });
```

- **展示/上传**：走 p02+p03 修正后的 V4 预签名 URL（`createSignedUrl`），浏览器侧用 `fetch` 直接 PUT/GET。

### p05 · OBS 错误响应缺 CORS 头 → 浏览器吞错

**现象**：任何 OBS 侧错误（AccessDenied、InvalidAccessKeyId、CORS 拒绝等）在浏览器里都只剩 `Network Error`，无法定位真实原因。

**根因**：预检失败时 OBS 的错误响应本身不带 CORS 头，浏览器同源策略直接丢弃响应体。这是浏览器行为，不是 OBS 不可用。

**诊断**（二选一，均可拿到真实状态码与错误体）：

```bash
# 方法①：curl 实测 OPTIONS 预检 —— 看 OBS 真实返回的状态码与错误体
curl -i -X OPTIONS 'https://<bucket>.obs.<region>.myhuaweicloud.com/<object-key>' \
  -H 'Origin: https://<your-app-origin>' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type,x-amz-acl'

# 方法②：Node 环境（无 CORS 约束）复现同一请求 —— 用 node fetch 重放浏览器的完整请求
node -e "fetch('<same-url>', {method:'PUT', headers:{'Origin':'https://<your-app-origin>'}}).then(r=>r.text().then(t=>console.log(r.status,t)))"
```

预检返回 403 `AccessForbidden` → CORS 规则缺方法/头部；返回 200 但带 `Access-Control-Allow-Origin: *` → CORS 已通，错误在别处（签名/ACL/策略）。

## CORS 配置（浏览器直传前置条件）

浏览器直传 OBS 前，桶必须先配置 CORS 规则，否则所有请求都会被预检拦截。

**KooCLI 缺口**：KooCLI 的 OBS 包装层未暴露 obsutil 的 `cors` 子命令——执行 `hcloud OBS cors` 报 `No such command`（`hcloud OBS help` 列表中也无 cors）。

**首选路径：MCP 工具 `huaweicloud_obs_set_cors`（#1003）**——内部 AWS4 签名调 OBS REST API（`PUT/GET/DELETE /?cors`），屏蔽签名细节。`action=set` 传 `rules` 数组（`allowedOrigin` / `allowedMethod[]` 必须含 HEAD / `allowedHeader[]` / `maxAgeSeconds`），工具在入参边界就拒绝缺 HEAD 的规则（p01 前置防线）；set/get 成功返回体自带 `verify` 命令（OPTIONS 预检）。SDK/控制台仅作降级路径。

**降级路径 ①：REST API `PUT /?cors` + CORS XML**

向桶 endpoint 发 `PUT /?cors`，body 为 CORSConfiguration XML；请求需带 AWS4 签名（Authorization 头，可用 SDK/工具生成，或使用插件内 `huaweicloud_obs_set_website_config` 同款的 AWS4 签名方式）。`PUT /?cors` 使用的 AllowedMethod 必须覆盖浏览器直传全部五个方法：

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://<your-app-origin></AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod> <!-- 缺 HEAD 会触发 p01：SDK 的 HEAD ?apiversion 探测被拒 -->
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

**降级路径 ②：esdk-obs-python `setBucketCors`**

服务端 Python 环境最小示例（凭证从环境变量读取，勿硬编码）：

```python
import os
from obs import ObsClient

client = ObsClient(
    access_key_id=os.environ['HUAWEICLOUD_SDK_AK'],
    secret_access_key=os.environ['HUAWEICLOUD_SDK_SK'],
    server='https://obs.<region>.myhuaweicloud.com',
)

client.setBucketCors(
    '<bucket>',
    [
        {
            'allowedOrigin': 'https://<your-app-origin>',
            'allowedMethod': ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],  # HEAD 必含，见 p01
            'allowedHeader': ['*'],
            'maxAgeSeconds': 3000,
        }
    ],
)
```

JSON 形态（供 MCP 工具/自研封装消费）：

```json
[
  {
    "allowedOrigin": "https://<your-app-origin>",
    "allowedMethod": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "allowedHeader": ["*"],
    "maxAgeSeconds": 3000
  }
]
```

配置完成后用 p05 的 curl OPTIONS 预检命令验证：预检应返回 200 且响应头含 `Access-Control-Allow-Origin`。走 `huaweicloud_obs_set_cors` 工具时，set/get 返回体的 `verify` 字段就是这条预检命令（含 `--noproxy '*'`，#1000 的注入代理陷阱同样适用于 OPTIONS 预检）。
