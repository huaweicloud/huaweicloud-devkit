import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targetPath = join(root, 'plugins', 'huaweicloud-core', 'src', 'data', 'icons-manifest.v1.json');
const MANIFEST_URL = 'https://open.huaweicloud.com/openplatform/icons/manifest.v1.json';
const MIN_ICONS = 100;
const TIMEOUT_MS = 30000;

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(MANIFEST_URL, {
      headers: { 'User-Agent': 'huaweicloud-devkit/update-icons-manifest' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: HTTP ${response.status}`);
  }
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.icons)) {
    throw new Error('Manifest is missing the icons array.');
  }
  if (manifest.icons.length < MIN_ICONS) {
    throw new Error(`Manifest has only ${manifest.icons.length} icons; expected at least ${MIN_ICONS}.`);
  }
  const prettier = await import('prettier');
  const prettierOptions = (await prettier.resolveConfig(targetPath)) || {};
  const formatted = await prettier.format(JSON.stringify(manifest, null, 2), {
    ...prettierOptions,
    parser: 'json',
  });
  writeFileSync(targetPath, formatted, 'utf8');
  console.log(
    `Updated ${targetPath} with ${manifest.icons.length} icons (schema ${manifest.schema_version}, generated ${manifest.generated_at}).`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
