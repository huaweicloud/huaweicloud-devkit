---
name: huaweicloud-codearts-cleanup
description: 'Clean up HuaweiCloud DevKit from a CodeArts Agent (.codeartsdoer) environment for fresh testing. Removes codearts skills, MCP registration, plugin runtime dir, KooCLI (hcloud dirs + PATH entry), and restores the default sandbox mode. Use when the user wants to fully reset the CodeArts Agent environment before reinstalling huaweicloud-devkit --target codearts.'
version: 1
---

# HuaweiCloud DevKit CodeArts Agent 环境清理

**STOP - Do not answer from general knowledge. Follow the procedure below.**

完整清理码道（CodeArts Agent）环境中已安装的 huaweicloud-devkit 运行时产物，用于模拟新用户、重新测试安装流程。

清理范围（A+B+C）：

- **A. 插件产物**：用户级与项目级 skills、MCP 注册、插件运行目录
- **B. KooCLI**：安装目录、配置目录、PATH 注册表项
- **C. 还原码道沙箱**：`permission/config.json` 的 `bash_mode` 还原为 `sandbox`

（报告/证据链目录不在清理范围，默认保留。）

## Step 1: 盘点当前状态

```powershell
Get-ChildItem "$env:USERPROFILE\.codeartsdoer\skills" -Name
Get-ChildItem "$env:USERPROFILE\.codeartsdoer\huaweicloud-plugins" -Recurse -Depth 1
Get-Content "$env:USERPROFILE\.codeartsdoer\mcp\mcp_settings.json" -Raw
Get-Content "C:\Users\sunzy\Documents\Codex\huaweicloud-devkit\.codeartsdoer\mcp\mcp_settings.json" -Raw
Test-Path "C:\Users\sunzy\hcloud"
Test-Path "C:\Users\sunzy\.hcloud"
Get-Content "$env:USERPROFILE\.codeartsdoer\codearts-data\storage\permission\config.json" -Raw
```

记录哪些目标存在，作为清理基线。

## Step 2: A. 删除插件产物

删除用户级与项目级 skills 目录下的所有 `huawei*`/`huaweicloud-*` 技能目录及状态文件：

```powershell
$userSkills = Get-ChildItem "$env:USERPROFILE\.codeartsdoer\skills" | Where-Object { $_.Name -like 'huawei*' -or $_.Name -eq 'UserSkillStatus.txt' }
$userSkills | Remove-Item -Recurse -Force
$projSkills = Get-ChildItem "C:\Users\sunzy\Documents\Codex\huaweicloud-devkit\.codeartsdoer\skills" | Where-Object { $_.Name -like 'huawei*' -or $_.Name -eq 'ProjectSkillStatus.txt' }
$projSkills | Remove-Item -Recurse -Force
```

删除插件运行目录：

```powershell
Remove-Item "$env:USERPROFILE\.codeartsdoer\huaweicloud-plugins" -Recurse -Force
Test-Path "$env:USERPROFILE\.codeartsdoer\huaweicloud-plugins"   # 应为 False
```

清空两级 MCP 注册（保留文件结构，勿删除文件本身）：

```powershell
'{"mcpServers": {}}' | Set-Content "$env:USERPROFILE\.codeartsdoer\mcp\mcp_settings.json" -Encoding UTF8
'{"mcpServers": {}}' | Set-Content "C:\Users\sunzy\Documents\Codex\huaweicloud-devkit\.codeartsdoer\mcp\mcp_settings.json" -Encoding UTF8
```

注意：`UserSkillStatus.txt` / `ProjectSkillStatus.txt` 可能被码道引擎自动重建为空文件，属正常现象，无需反复删除。

## Step 3: B. 删除 KooCLI

删除安装目录与配置目录：

```powershell
Remove-Item "C:\Users\sunzy\hcloud" -Recurse -Force
Remove-Item "C:\Users\sunzy\.hcloud" -Recurse -Force
```

从用户 PATH 移除 `C:\Users\sunzy\hcloud` 项。

**反斜杠陷阱**：直接用 `-ne 'C:\Users\sunzy\hcloud'` 比较可能因工具层对反斜杠的转义而不生效。必须用 `Contains('hcloud')` 判断：

```powershell
$reg = (Get-ItemProperty -Path 'HKCU:\Environment').Path
$parts = $reg.Split(';')
$filtered = @()
foreach ($p in $parts) { if (-not $p.ToLower().Contains('hcloud')) { $filtered += $p } }
$new = $filtered -join ';'
Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $new
$v = (Get-ItemProperty -Path 'HKCU:\Environment').Path
$v.ToLower().Contains('hcloud')   # 应为 False
```

## Step 4: C. 还原码道沙箱

将权限配置从 `always_allow` 还原为默认 `sandbox`（模拟新用户的沙箱模式）：

```powershell
'{"bash_mode": "sandbox"}' | Set-Content "$env:USERPROFILE\.codeartsdoer\codearts-data\storage\permission\config.json" -Encoding UTF8
Get-Content "$env:USERPROFILE\.codeartsdoer\codearts-data\storage\permission\config.json" -Raw
```

## Step 5: 验证清理完成

```powershell
Get-ChildItem "$env:USERPROFILE\.codeartsdoer\skills" -Directory -Name          # 应无 huawei* 目录
Get-ChildItem "C:\Users\sunzy\Documents\Codex\huaweicloud-devkit\.codeartsdoer\skills" -Directory -Name
Test-Path "$env:USERPROFILE\.codeartsdoer\huaweicloud-plugins"                  # 应为 False
Test-Path "C:\Users\sunzy\hcloud"                                               # 应为 False
Test-Path "C:\Users\sunzy\.hcloud"                                              # 应为 False
Get-Command hcloud -ErrorAction SilentlyContinue                                # 应无结果
(Get-ItemProperty -Path 'HKCU:\Environment').Path.ToLower().Contains('hcloud')  # 应为 False
Get-Content "$env:USERPROFILE\.codeartsdoer\codearts-data\storage\permission\config.json" -Raw  # bash_mode: sandbox
```

全部检查返回 False/无结果/`sandbox` 后，即可重新安装：

```bash
node plugins/huaweicloud-core/src/setup-cli.mjs install --target codearts
```

## 边界与注意事项

- 本流程**不删除** `C:\Users\sunzy\Documents\huaweicloud-devkit-test-report\`（测试报告与证据链保留）。
- 还原沙箱后，后续 `install-hcloud` 在码道沙箱模式下会被阻止写 `~/.hcloud`（EPERM + 隐私协议无法持久化）。这是预期行为——沙箱场景下应提示用户在码道外终端安装或解除沙箱，而非尝试在沙箱内强行安装。
- `npx huaweicloud-devkit uninstall --target codearts` 可自动完成大部分清理；本流程适用于需要全手动、精确控制的场景（含 PATH 注册表与沙箱还原）。
