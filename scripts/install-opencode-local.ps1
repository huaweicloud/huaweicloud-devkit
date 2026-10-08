param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$OpenCodeConfigRoot = "$HOME\.config\opencode"
)

$ErrorActionPreference = "Stop"

$pluginRoot = Join-Path $RepoRoot "plugins\huaweicloud-core"
$sourceSkills = Join-Path $pluginRoot "skills"
$sourceSrc = Join-Path $pluginRoot "src"
$sourceSafety = Join-Path $pluginRoot "safety"
$targetBase = Join-Path $OpenCodeConfigRoot "huaweicloud-plugins"
$targetSkills = Join-Path $targetBase "skills"
$targetCommands = Join-Path $OpenCodeConfigRoot "commands"
$targetSrc = Join-Path $targetBase "src"
$targetSafety = Join-Path $targetBase "safety"

New-Item -ItemType Directory -Force -Path $targetSkills | Out-Null
New-Item -ItemType Directory -Force -Path $targetCommands | Out-Null
New-Item -ItemType Directory -Force -Path $targetSrc | Out-Null
New-Item -ItemType Directory -Force -Path $targetSafety | Out-Null

Copy-Item -Recurse -Force -Path (Join-Path $sourceSkills "*") -Destination $targetSkills
Copy-Item -Recurse -Force -Path (Join-Path $sourceSrc "*") -Destination $targetSrc
Copy-Item -Recurse -Force -Path (Join-Path $sourceSafety "*") -Destination $targetSafety
Copy-Item -Recurse -Force -Path (Join-Path $RepoRoot "integrations\opencode\commands\*") -Destination $targetCommands

# skill-tracker.js hook file
$hookSrc = Join-Path $RepoRoot "integrations\opencode\hooks\skill-tracker.js"
$pluginDst = Join-Path $OpenCodeConfigRoot "plugins"
New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
Copy-Item -LiteralPath $hookSrc -Destination (Join-Path $pluginDst "skill-tracker.js") -Force
Write-Host "Hook skill-tracker.js -> $pluginDst\skill-tracker.js"

Write-Host "OpenCode skills installed to: $targetSkills"
Write-Host "OpenCode commands installed to: $targetCommands"
Write-Host "MCP server (src) installed to: $targetSrc"
Write-Host "Safety policy installed to: $targetSafety"

$nodeVersion = (node --version 2>$null) -replace '^v', ''
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Node.js not found. MCP server requires Node.js >= 20."
} elseif ([version]$nodeVersion -lt [version]"20.0.0") {
    Write-Warning "Node.js $nodeVersion detected. MCP server requires Node.js >= 20."
} else {
    Write-Host "Node.js $nodeVersion OK."
}

Write-Host ""
Write-Host "Add the following MCP section to your OpenCode config ($OpenCodeConfigRoot\opencode.json):"
Write-Host '{
  "mcp": {
    "servers": {
      "huaweicloud-devkit": {
        "type": "local",
        "command": ["node", "'$targetBase\src\mcp-server.mjs'"]
      }
    }
  }
}'
