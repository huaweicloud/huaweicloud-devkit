param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

$pluginName      = "huaweicloud-devkit"
$marketplaceName = "huaweicloud-devkit"
$pluginSourceDir = Join-Path $RepoRoot "plugins\huaweicloud-core"

if (-not (Test-Path $pluginSourceDir)) {
  Write-Host "ERROR: Plugin source directory not found at $pluginSourceDir"
  exit 1
}

$pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$ts = (Get-Date -Format "yyyyMMddHHmmss").Trim()
$pluginVersion = "$($pkg.version)+codex.$ts"
Write-Host "Plugin version: $pluginVersion"

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-JsonFile($path, $data, $depth = 5) {
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $json = $data | ConvertTo-Json -Depth $depth
  [System.IO.File]::WriteAllText($path, $json, $utf8NoBom)
}

# === 1. Construct plugin.json ===
Write-Host "--- Step 1: Constructing plugin.json ---"
$pluginJson = @{
  name        = $pluginName
  version     = $pluginVersion
  description = $pkg.description
  author      = @{ name = "HuaweiCloud Mate"; url = "https://github.com/huaweicloud" }
  homepage    = "https://github.com/huaweicloud/HuaweiCloud-Devkit"
  repository  = "https://github.com/huaweicloud/HuaweiCloud-Devkit"
  license     = "Apache-2.0"
  keywords    = @("huaweicloud","huawei-cloud","koocli","hcloud","agent","mcp","api","sdk","skills")
  skills      = "./skills/"
  mcpServers  = "./.mcp.json"
  interface   = @{
    displayName      = "HuaweiCloud Devkit"
    shortDescription = "HuaweiCloud Devkit - Huawei Cloud guidance, CLI/API/SDK routing, MCP tools, and safety for coding agents."
    longDescription  = "HuaweiCloud Devkit helps coding agents choose and use Huawei Cloud Skills, KooCLI, APIs, SDKs, and MCP tools with less context, safer command execution, and more accurate cloud implementation decisions."
    developerName    = "HuaweiCloud Mate"
    category         = "Cloud"
    capabilities     = @("Read", "Interactive")
    websiteURL       = "https://github.com/huaweicloud/HuaweiCloud-Devkit"
    brandColor       = "#C7000B"
    defaultPrompt    = @("Help me choose the right Huawei Cloud capability.","Check my Huawei Cloud CLI setup safely.","Plan this Huawei Cloud API or SDK task.")
  }
}
$pluginJsonPath = Join-Path $pluginSourceDir ".codex-plugin\plugin.json"
Write-JsonFile $pluginJsonPath $pluginJson
Write-Host "Written plugin.json: $pluginJsonPath"

# === 2. Construct repo marketplace.json ===
# source.path is relative to the marketplace root (<repo>/.agents/).
# ./plugins/huaweicloud-core resolves to <repo>/plugins/huaweicloud-core
Write-Host "--- Step 2: Constructing repo marketplace.json ---"
$repoMarketplaceJson = @{
  name      = $marketplaceName
  interface = @{ displayName = "HuaweiCloud Devkit" }
  plugins   = @(
    @{
      name     = $pluginName
      source   = @{ source = "local"; path = "./plugins/huaweicloud-core" }
      policy   = @{ installation = "AVAILABLE"; authentication = "ON_USE" }
      category = "Cloud"
    }
  )
}
$repoMarketplacePath = Join-Path $RepoRoot ".agents\plugins\marketplace.json"
Write-JsonFile $repoMarketplacePath $repoMarketplaceJson
Write-Host "Written repo marketplace: $repoMarketplacePath"

# === 3. Clean stale caches + shadowing personal marketplace ===
# Repo plugins must NOT be in the personal marketplace. The personal
# marketplace resolves source.path relative to ~/.agents/, which does
# not contain plugins/huaweicloud-core. Both Codex CLI and Desktop
# discover repo plugins through registered marketplaces.
Write-Host "--- Step 3: Cleaning stale caches and shadowing ---"
$codexMarketplaceCache = Join-Path $HOME ".codex\plugins\marketplaces\$marketplaceName"
$codexPluginCache      = Join-Path $HOME ".codex\plugins\cache\$pluginName"
foreach ($stalePath in @($codexMarketplaceCache, $codexPluginCache)) {
  if (Test-Path $stalePath) {
    Write-Host "Removing stale cache: $stalePath"
    Remove-Item -Recurse -Force $stalePath -ErrorAction SilentlyContinue
  }
}

$personalMarketplacePath = Join-Path $HOME ".agents\plugins\marketplace.json"
if (Test-Path $personalMarketplacePath) {
  try {
    $personalData = Get-Content $personalMarketplacePath -Raw | ConvertFrom-Json
    if ($personalData.name -eq $marketplaceName) {
      Write-Host "Removing shadowing personal marketplace: $personalMarketplacePath"
      Remove-Item -Force $personalMarketplacePath -ErrorAction SilentlyContinue
    }
    else {
      Write-Host "Personal marketplace has different name, leaving as-is."
    }
  }
  catch {
    Write-Host "Could not parse personal marketplace; removing: $personalMarketplacePath"
    Remove-Item -Force $personalMarketplacePath -ErrorAction SilentlyContinue
  }
}

# === 4. Register repo marketplace and install ===
# codex plugin marketplace add registers the repo marketplace for both
# Codex CLI and Codex Desktop. Both environments discover plugins from
# registered marketplaces the same way.
Write-Host "--- Step 4: Registering marketplace and installing plugin ---"
Write-Host "Registering local Codex marketplace from: $RepoRoot"
codex plugin marketplace add $RepoRoot
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARNING: Failed to register marketplace (exit $LASTEXITCODE)."
  Write-Host "Run in a terminal with codex CLI: codex plugin marketplace add `"$RepoRoot`""
  exit 0
}

Write-Host "Installing plugin: $pluginName@$marketplaceName"
codex plugin add "$pluginName@$marketplaceName"
if ($LASTEXITCODE -ne 0) {
  Write-Host "WARNING: codex plugin add failed (exit $LASTEXITCODE)."
  Write-Host "Manually run: codex plugin add $pluginName@$marketplaceName"
  exit 0
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host "plugin.json + marketplace.json constructed from package.json."
Write-Host "Plugin installed via repo marketplace (Codex CLI + Desktop)."
Write-Host "Start a new Codex thread to pick up the plugin."
