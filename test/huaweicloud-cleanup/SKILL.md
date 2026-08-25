---
name: huaweicloud-cleanup
description: 'Clean up HuaweiCloud DevKit environment for fresh testing. Removes plugin files, skills, MCP server, KooCLI, and Codex plugin registration. Use when the user wants a clean test environment or to reset before reinstall.'
version: 1
---

# HuaweiCloud DevKit Cleanup

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Complete environment cleanup for fresh testing.

## Step 1: Check Current State

```powershell
Test-Path $env:USERPROFILE\.config\opencode\huaweicloud-plugins
Test-Path $env:USERPROFILE\.hcloud
hcloud version 2>$null
```

## Step 2: Uninstall Plugin

```powershell
npx --yes huaweicloud-devkit uninstall --target all
```

## Step 3: Remove OpenCode Files

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.config\opencode\skills\huawei* -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:USERPROFILE\.config\opencode\huaweicloud-plugins -ErrorAction SilentlyContinue
Remove-Item -Force $env:USERPROFILE\.config\opencode\commands\huaweicloud* -ErrorAction SilentlyContinue
```

## Step 4: Remove MCP Config

Remove `mcp.huaweicloud-devkit` entry from both:

- `~\.config\opencode\opencode.json`
- `~\.config\opencode\opencode.jsonc` (if exists)

```powershell
$files = @("$env:USERPROFILE\.config\opencode\opencode.json", "$env:USERPROFILE\.config\opencode\opencode.jsonc")
foreach ($f in $files) {
  if (Test-Path $f) {
    $c = Get-Content $f -Raw | ConvertFrom-Json
    if ($c.mcp.PSObject.Properties.Name -contains 'huaweicloud-devkit') {
      $c.mcp.PSObject.Properties.Remove('huaweicloud-devkit')
      if ($c.mcp.PSObject.Properties.Count -eq 0) { $c.PSObject.Properties.Remove('mcp') }
      $c | ConvertTo-Json -Depth 5 | Set-Content $f -Encoding UTF8
    }
  }
}
```

## Step 5: Uninstall KooCLI

```powershell
npm uninstall -g @huaweicloud/hcloud
Remove-Item -Recurse -Force $env:USERPROFILE\.hcloud -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:USERPROFILE\.hcloud-agent -ErrorAction SilentlyContinue
```

## Step 6: Remove Codex Plugin

```powershell
codex plugin remove "huaweicloud-core@huaweicloud-devkit" 2>$null
codex plugin marketplace remove huaweicloud-devkit 2>$null
codex plugin marketplace remove HuaweiCloud-Devkit 2>$null
```

## Step 7: Verify Clean

```powershell
hcloud version          # Should error: not found
Test-Path $env:USERPROFILE\.config\opencode\huaweicloud-plugins  # Should be False
```

All checks should return errors or False. Then reinstall:

```bash
npx --yes huaweicloud-devkit install
```
