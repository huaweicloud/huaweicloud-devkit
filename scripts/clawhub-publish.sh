#!/usr/bin/env bash
# HuaweiCloud DevKit → ClawHub Publisher
# 从 npm 发布后，将插件推送到 ClawHub
#
# 用法:
#   CLAWHUB_TOKEN=<token> ./scripts/clawhub-publish.sh 1.0.2-next.20
#
set -euo pipefail

VERSION="${1:?Usage: $0 <version>}"
OWNER="${CLAWHUB_OWNER:-huaweicloud}"
NAME="huaweicloud-devkit"
DISPLAY_NAME="HuaweiCloud DevKit"

echo "[1/4] 下载 npm 包 huaweicloud-devkit@${VERSION}..."
WORK_DIR=$(mktemp -d)
pushd "$WORK_DIR" > /dev/null
npm pack "huaweicloud-devkit@${VERSION}" --pack-destination . 2>&1
PKG_FILE=$(ls huaweicloud-devkit-*.tgz)
tar -xzf "$PKG_FILE"
PLUGIN_DIR="$WORK_DIR/package/plugins/huaweicloud-core"
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "::error:: 未找到 plugins/huaweicloud-core，包结构可能已变更"
  exit 1
fi
echo "  插件目录: $PLUGIN_DIR"
popd > /dev/null

echo "[2/4] 检查 openclaw.plugin.json..."
if [ ! -f "$PLUGIN_DIR/openclaw.plugin.json" ]; then
  echo "::error:: openclaw.plugin.json 缺失"
  exit 1
fi

echo "[3/4] 发布到 ClawHub..."
clawhub package publish "$PLUGIN_DIR" \
  --family bundle-plugin \
  --name "$NAME" \
  --display-name "$DISPLAY_NAME" \
  --version "$VERSION" \
  --bundle-format codex \
  --owner "$OWNER" \
  --json 2>&1

echo "[4/4] 清理..."
rm -rf "$WORK_DIR"
echo "✓ 完成. 用户安装: openclaw plugins install clawhub:${NAME}"
