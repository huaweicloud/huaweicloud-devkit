import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { detectFramework } from '../plugins/huaweicloud-core/src/detect-framework.mjs';

function tmpDir() {
  const dir = join(tmpdir(), 'devkit-test-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, filename, obj) {
  writeFileSync(join(dir, filename), JSON.stringify(obj, null, 2), 'utf8');
}

function touchFile(dir, filename, content = '') {
  const p = join(dir, filename);
  const parent = join(p, '..');
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('detectFramework returns null for empty directory', () => {
  const d = tmpDir();
  try {
    assert.equal(detectFramework(d), null);
  } finally {
    cleanup(d);
  }
});

test('detectFramework returns null for non-web project', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'lib', dependencies: { lodash: '^4' } });
    assert.equal(detectFramework(d), null);
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Next.js', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'my-next-app',
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: '^14', react: '^18' },
    });
    touchFile(d, 'next.config.js');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssr');
    assert.equal(result.framework, 'Next.js');
    assert.equal(result.port, 3000);
    assert.equal(result.outputDir, '.next');
    assert.equal(result.nginxType, 'proxy');
    assert.ok(result.serveCmd);
    assert.ok(result.packageManager);
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Nuxt', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'my-nuxt-app', dependencies: { nuxt: '^3' } });
    touchFile(d, 'nuxt.config.ts');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssr');
    assert.equal(result.framework, 'Nuxt');
    assert.equal(result.port, 3000);
    assert.equal(result.outputDir, '.output');
    assert.equal(result.nginxType, 'proxy');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects VitePress', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'my-docs', devDependencies: { vitepress: '^1' } });
    mkdirSync(join(d, '.vitepress'));
    touchFile(d, '.vitepress/config.mts');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssg');
    assert.equal(result.framework, 'VitePress');
    assert.equal(result.port, 8080);
    assert.equal(result.outputDir, '.vitepress/dist');
    assert.equal(result.nginxType, 'spa');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Docusaurus', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'my-docs', dependencies: { '@docusaurus/core': '^3' } });
    touchFile(d, 'docusaurus.config.js');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssg');
    assert.equal(result.framework, 'Docusaurus');
    assert.equal(result.outputDir, 'build');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Hugo', () => {
  const d = tmpDir();
  try {
    touchFile(d, 'hugo.toml');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssg');
    assert.equal(result.framework, 'Hugo');
    assert.equal(result.outputDir, 'public');
    assert.equal(result.installCmd, null);
    assert.equal(result.buildCmd, 'hugo');
    assert.equal(result.nginxType, 'static');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Hexo', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'my-blog', dependencies: { hexo: '^7' } });
    touchFile(d, '_config.yml');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssg');
    assert.equal(result.framework, 'Hexo');
    assert.equal(result.outputDir, 'public');
    assert.equal(result.nginxType, 'static');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Taro', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'mini-shop',
      scripts: { 'build:h5': 'taro build --type h5' },
      dependencies: { '@tarojs/taro': '^3.6' },
    });
    const result = detectFramework(d);
    assert.equal(result.type, 'cross-platform');
    assert.equal(result.framework, 'Taro');
    assert.equal(result.buildCmd, 'npm run build:h5');
    assert.equal(result.outputDir, 'dist');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects uni-app', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'uni-project',
      scripts: { 'build:h5': 'uni build' },
      dependencies: { '@dcloudio/uni-app': '^3' },
    });
    const result = detectFramework(d);
    assert.equal(result.type, 'cross-platform');
    assert.equal(result.framework, 'uni-app');
    assert.equal(result.outputDir, 'dist/build/h5');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Vite SPA', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'my-app',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { vue: '^3', 'vue-router': '^4' },
      devDependencies: { vite: '^5' },
    });
    touchFile(d, 'vite.config.ts');
    const result = detectFramework(d);
    assert.equal(result.type, 'spa');
    assert.equal(result.framework, 'Vite (React/Vue/Svelte)');
    assert.equal(result.outputDir, 'dist');
    assert.equal(result.port, 8080);
    assert.equal(result.nginxType, 'spa');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Create React App', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'cra-app',
      scripts: { build: 'react-scripts build' },
      dependencies: { react: '^18', 'react-dom': '^18', 'react-scripts': '^5' },
    });
    touchFile(d, 'public/index.html');
    const result = detectFramework(d);
    assert.equal(result.type, 'spa');
    assert.equal(result.framework, 'Create React App');
    assert.equal(result.outputDir, 'build');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Angular', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'ng-app', dependencies: { '@angular/core': '^17' } });
    writeJson(d, 'angular.json', {
      defaultProject: 'ng-app',
      projects: {
        'ng-app': { architect: { build: { options: { outputPath: 'dist/ng-app' } } } },
      },
    });
    const result = detectFramework(d);
    assert.equal(result.type, 'spa');
    assert.equal(result.framework, 'Angular');
    assert.equal(result.outputDir, 'dist/ng-app');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Monorepo with sub-apps', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'saas-platform', private: true });
    touchFile(d, 'pnpm-workspace.yaml');
    touchFile(d, 'turbo.json');

    const appDir = join(d, 'apps', 'web');
    mkdirSync(appDir, { recursive: true });
    writeJson(appDir, 'package.json', { name: '@saas/web', dependencies: { next: '^14', react: '^18' } });
    touchFile(appDir, 'next.config.js');

    const adminDir = join(d, 'apps', 'admin');
    mkdirSync(adminDir, { recursive: true });
    writeJson(adminDir, 'package.json', { name: '@saas/admin', dependencies: { vue: '^3' } });
    touchFile(adminDir, 'vite.config.ts');

    const result = detectFramework(d);
    assert.equal(result.type, 'monorepo');
    assert.equal(result.framework, 'Monorepo');
    assert.equal(result.monorepoTool, 'Turborepo');
    assert.equal(result.subApps.length, 2);

    const webApp = result.subApps.find((a) => a.name === '@saas/web');
    assert.ok(webApp);
    assert.equal(webApp.type, 'ssr');
    assert.equal(webApp.framework, 'Next.js');

    const adminApp = result.subApps.find((a) => a.name === '@saas/admin');
    assert.ok(adminApp);
    assert.equal(adminApp.type, 'spa');
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects package manager from lock files', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'test' });
    touchFile(d, 'vite.config.js');
    touchFile(d, 'pnpm-lock.yaml');
    assert.equal(detectFramework(d).packageManager, 'pnpm');
  } finally {
    cleanup(d);
  }

  const d2 = tmpDir();
  try {
    writeJson(d2, 'package.json', { name: 'test' });
    touchFile(d2, 'vite.config.js');
    touchFile(d2, 'yarn.lock');
    assert.equal(detectFramework(d2).packageManager, 'yarn');
  } finally {
    cleanup(d2);
  }

  const d3 = tmpDir();
  try {
    writeJson(d3, 'package.json', { name: 'test' });
    touchFile(d3, 'vite.config.js');
    touchFile(d3, 'package-lock.json');
    assert.equal(detectFramework(d3).packageManager, 'npm');
  } finally {
    cleanup(d3);
  }
});

test('detectFramework static fallback for project with index.html but no framework', () => {
  const d = tmpDir();
  try {
    touchFile(d, 'index.html', '<html></html>');
    const result = detectFramework(d);
    assert.equal(result.type, 'static');
    assert.equal(result.framework, 'Static Site');
    assert.equal(result.buildCmd, null);
    assert.equal(result.installCmd, null);
    assert.equal(result.outputDir, '.');
  } finally {
    cleanup(d);
  }
});

test('detectFramework returns projectPath in rootDir', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'test', dependencies: { react: '^18' } });
    touchFile(d, 'vite.config.js');
    const result = detectFramework(d);
    assert.equal(result.rootDir, d);
  } finally {
    cleanup(d);
  }
});

test('detectFramework detects Vue CLI before CRA fallback', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'vue-cli-app',
      scripts: { build: 'vue-cli-service build' },
      dependencies: { vue: '^3', 'vue-router': '^4' },
      devDependencies: { '@vue/cli-service': '^5' },
    });
    touchFile(d, 'public/index.html');
    const result = detectFramework(d);
    assert.equal(result.framework, 'Vue CLI');
    assert.equal(result.outputDir, 'dist');
  } finally {
    cleanup(d);
  }
});

test('detectFramework patches serveCmd for pnpm projects', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'pnpm-next-app',
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: '^14', react: '^18' },
    });
    touchFile(d, 'next.config.js');
    touchFile(d, 'pnpm-lock.yaml');
    const result = detectFramework(d);
    assert.equal(result.packageManager, 'pnpm');
    assert.equal(result.installCmd, 'pnpm install');
    assert.equal(result.buildCmd, 'pnpm run build');
    assert.ok(result.serveCmd.includes('pnpm start'), 'serveCmd should use pnpm start');
  } finally {
    cleanup(d);
  }
});

test('detectFramework handles non-web monorepo sub-apps gracefully', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'monorepo-root', private: true });
    touchFile(d, 'pnpm-workspace.yaml');

    const appDir = join(d, 'apps', 'web');
    mkdirSync(appDir, { recursive: true });
    writeJson(appDir, 'package.json', { name: '@mono/web', dependencies: { next: '^14', react: '^18' } });
    touchFile(appDir, 'next.config.js');

    const libDir = join(d, 'packages', 'utils');
    mkdirSync(libDir, { recursive: true });
    writeJson(libDir, 'package.json', { name: '@mono/utils', dependencies: { lodash: '^4' } });

    const result = detectFramework(d);
    assert.equal(result.subApps.length, 1);
    assert.equal(result.subApps[0].name, '@mono/web');
    assert.equal(result.subApps[0].type, 'ssr');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects Vite with .cjs config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'my-app',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { vue: '^3' },
      devDependencies: { vite: '^5' },
    });
    touchFile(d, 'vite.config.cjs');
    const result = detectFramework(d);
    assert.equal(result.type, 'spa');
    assert.equal(result.framework, 'Vite (React/Vue/Svelte)');
    assert.equal(result.outputDir, 'dist');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects Next.js with .cjs config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'next-app',
      dependencies: { next: '^14', react: '^18' },
    });
    touchFile(d, 'next.config.cjs');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssr');
    assert.equal(result.framework, 'Next.js');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects Nuxt with .mts config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'nuxt-app', dependencies: { nuxt: '^3' } });
    touchFile(d, 'nuxt.config.mts');
    const result = detectFramework(d);
    assert.equal(result.type, 'ssr');
    assert.equal(result.framework, 'Nuxt');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects Vite with .mts config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'mts-app',
      dependencies: { vue: '^3' },
      devDependencies: { vite: '^5' },
    });
    touchFile(d, 'vite.config.mts');
    const result = detectFramework(d);
    assert.equal(result.type, 'spa');
    assert.equal(result.framework, 'Vite (React/Vue/Svelte)');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects Vue project with entry file but no config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'vue-no-config',
      dependencies: { vue: '^3', 'vue-router': '^4' },
    });
    touchFile(d, 'src/main.js', "import { createApp } from 'vue';");
    const result = detectFramework(d);
    assert.ok(result !== null, 'should detect Vue project with entry file');
    assert.equal(result.framework, 'Vue CLI');
    assert.equal(result.type, 'spa');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects React project with entry file but no config', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', {
      name: 'react-no-config',
      dependencies: { react: '^18', 'react-dom': '^18' },
    });
    touchFile(d, 'src/main.jsx', "import React from 'react';");
    const result = detectFramework(d);
    assert.ok(result !== null, 'should detect React project with entry file');
    assert.equal(result.framework, 'Create React App');
    assert.equal(result.type, 'spa');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework detects static site with src/index.html', () => {
  const d = tmpDir();
  try {
    touchFile(d, 'src/index.html', '<html><body>hello</body></html>');
    const result = detectFramework(d);
    assert.ok(result !== null, 'should detect static site with src/index.html');
    assert.equal(result.framework, 'Static Site');
    assert.equal(result.type, 'static');
  } finally {
    cleanup(d);
  }
});

test('D3-B5: detectFramework still returns null for pure library project', () => {
  const d = tmpDir();
  try {
    writeJson(d, 'package.json', { name: 'lib', dependencies: { lodash: '^4' } });
    assert.equal(detectFramework(d), null);
  } finally {
    cleanup(d);
  }
});
