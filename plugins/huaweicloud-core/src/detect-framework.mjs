import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FRAMEWORKS = {
  nextjs: {
    type: 'ssr',
    framework: 'Next.js',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: '.next',
    port: 3000,
    serveCmd: 'nohup npm start > /tmp/app.log 2>&1 &',
    checkUrl: 'http://localhost:3000',
    nginxType: 'proxy',
  },
  nuxt: {
    type: 'ssr',
    framework: 'Nuxt',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: '.output',
    port: 3000,
    serveCmd: 'nohup node .output/server/index.mjs > /tmp/app.log 2>&1 &',
    checkUrl: 'http://localhost:3000',
    nginxType: 'proxy',
  },
  vitepress: {
    type: 'ssg',
    framework: 'VitePress',
    installCmd: 'npm install',
    buildCmd: 'npm run docs:build',
    outputDir: '.vitepress/dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  docusaurus: {
    type: 'ssg',
    framework: 'Docusaurus',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'build',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  hugo: {
    type: 'ssg',
    framework: 'Hugo',
    installCmd: null,
    buildCmd: 'hugo',
    outputDir: 'public',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
  hexo: {
    type: 'ssg',
    framework: 'Hexo',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'public',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
  taro: {
    type: 'cross-platform',
    framework: 'Taro',
    installCmd: 'npm install',
    buildCmd: 'npm run build:h5',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  uniapp: {
    type: 'cross-platform',
    framework: 'uni-app',
    installCmd: 'npm install',
    buildCmd: 'npm run build:h5',
    outputDir: 'dist/build/h5',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  angular: {
    type: 'spa',
    framework: 'Angular',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: null,
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  vite: {
    type: 'spa',
    framework: 'Vite (React/Vue/Svelte)',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  cra: {
    type: 'spa',
    framework: 'Create React App',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'build',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  vueCli: {
    type: 'spa',
    framework: 'Vue CLI',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    outputDir: 'dist',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'spa',
  },
  static: {
    type: 'static',
    framework: 'Static Site',
    installCmd: null,
    buildCmd: null,
    outputDir: '.',
    port: 8080,
    serveCmd: null,
    checkUrl: 'http://localhost:8080',
    nginxType: 'static',
  },
};

function readPkg(projectPath) {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function detectPackageManager(projectPath, pkg) {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(projectPath, 'bun.lockb'))) return 'bun';
  const declared = (pkg?.packageManager || '').split('@')[0];
  if (declared && ['pnpm', 'yarn', 'npm', 'bun'].includes(declared)) return declared;
  return 'npm';
}

function collectDeps(pkg) {
  if (!pkg) return {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

function scanSubApps(projectPath) {
  const apps = [];
  for (const dir of ['apps', 'packages']) {
    const dirPath = join(projectPath, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPath = join(dirPath, entry.name);
        const subPkg = readPkg(subPath);
        if (!subPkg) continue;
        const result = detectFramework(subPath);
        if (!result) continue;
        apps.push({
          name: subPkg.name || entry.name,
          path: `${dir}/${entry.name}`,
          framework: result.framework,
          type: result.type,
        });
      }
    } catch {
      // skip unreadable directories
    }
  }
  return apps;
}

function resolveAngularOutput(projectPath, pkg) {
  try {
    const angularJson = join(projectPath, 'angular.json');
    if (existsSync(angularJson)) {
      const config = JSON.parse(readFileSync(angularJson, 'utf8'));
      const defaultProject = config.defaultProject || Object.keys(config.projects || {})[0];
      if (defaultProject && config.projects?.[defaultProject]?.architect?.build?.options?.outputPath) {
        return config.projects[defaultProject].architect.build.options.outputPath;
      }
    }
  } catch {
    // ignore parse errors
  }
  const name = pkg?.name || 'app';
  return `dist/${name}`;
}

function patchCommands(result, pm) {
  if (result.installCmd && result.installCmd.startsWith('npm install')) {
    if (pm === 'pnpm') result.installCmd = 'pnpm install';
    else if (pm === 'yarn') result.installCmd = 'yarn install';
  }
  if (result.buildCmd && result.buildCmd.startsWith('npm run')) {
    if (pm === 'pnpm') result.buildCmd = result.buildCmd.replace('npm run', 'pnpm run');
    else if (pm === 'yarn') result.buildCmd = result.buildCmd.replace('npm run', 'yarn run');
  }
  if (result.serveCmd && result.serveCmd.includes('npm start')) {
    if (pm === 'pnpm') result.serveCmd = result.serveCmd.replace('npm start', 'pnpm start');
    else if (pm === 'yarn') result.serveCmd = result.serveCmd.replace('npm start', 'yarn start');
  }
  return result;
}

function frameworkResult(fw, pm, projectPath) {
  return patchCommands({ ...fw, packageManager: pm, rootDir: projectPath }, pm);
}

function readVitepressOutDir(projectPath) {
  const configFiles = ['config.mts', 'config.ts', 'config.mjs', 'config.js'];
  for (const cf of configFiles) {
    const configPath = join(projectPath, '.vitepress', cf);
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, 'utf8');
      const match = content.match(/outDir\s*:\s*['"`]?([^'"`\s,}]+)['"`]?/);
      if (match) return match[1];
    } catch {}
  }
  return null;
}

export function detectFramework(projectPath) {
  const pkg = readPkg(projectPath);
  const deps = collectDeps(pkg);
  const pm = detectPackageManager(projectPath, pkg);

  if (
    existsSync(join(projectPath, 'pnpm-workspace.yaml')) ||
    existsSync(join(projectPath, 'turbo.json')) ||
    existsSync(join(projectPath, 'nx.json')) ||
    existsSync(join(projectPath, 'lerna.json'))
  ) {
    const monorepoSubApps = scanSubApps(projectPath);
    return {
      type: 'monorepo',
      framework: 'Monorepo',
      monorepoTool: existsSync(join(projectPath, 'turbo.json'))
        ? 'Turborepo'
        : existsSync(join(projectPath, 'nx.json'))
          ? 'Nx'
          : existsSync(join(projectPath, 'lerna.json'))
            ? 'Lerna'
            : 'pnpm Workspace',
      subApps: monorepoSubApps,
      packageManager: pm,
      rootDir: projectPath,
    };
  }

  if (
    existsSync(join(projectPath, 'next.config.js')) ||
    existsSync(join(projectPath, 'next.config.mjs')) ||
    existsSync(join(projectPath, 'next.config.ts'))
  ) {
    return frameworkResult(FRAMEWORKS.nextjs, pm, projectPath);
  }

  if (
    existsSync(join(projectPath, 'nuxt.config.js')) ||
    existsSync(join(projectPath, 'nuxt.config.mjs')) ||
    existsSync(join(projectPath, 'nuxt.config.ts'))
  ) {
    return frameworkResult(FRAMEWORKS.nuxt, pm, projectPath);
  }

  if ('@tarojs/taro' in deps) {
    return frameworkResult(FRAMEWORKS.taro, pm, projectPath);
  }

  if ('@dcloudio/uni-app' in deps || 'uni-app' in deps) {
    return frameworkResult(FRAMEWORKS.uniapp, pm, projectPath);
  }

  if (existsSync(join(projectPath, '.vitepress'))) {
    const outDir = readVitepressOutDir(projectPath);
    return frameworkResult(
      outDir ? { ...FRAMEWORKS.vitepress, outputDir: outDir } : FRAMEWORKS.vitepress,
      pm,
      projectPath,
    );
  }

  if (
    existsSync(join(projectPath, 'docusaurus.config.js')) ||
    existsSync(join(projectPath, 'docusaurus.config.ts')) ||
    existsSync(join(projectPath, 'docusaurus.config.mjs'))
  ) {
    return frameworkResult(FRAMEWORKS.docusaurus, pm, projectPath);
  }

  if (existsSync(join(projectPath, 'hugo.toml')) || existsSync(join(projectPath, 'config.toml'))) {
    return frameworkResult(FRAMEWORKS.hugo, pm, projectPath);
  }

  if (existsSync(join(projectPath, '_config.yml'))) {
    return frameworkResult(FRAMEWORKS.hexo, pm, projectPath);
  }

  if (existsSync(join(projectPath, 'angular.json'))) {
    const outputDir = resolveAngularOutput(projectPath, pkg);
    return frameworkResult({ ...FRAMEWORKS.angular, outputDir }, pm, projectPath);
  }

  if (
    existsSync(join(projectPath, 'vite.config.js')) ||
    existsSync(join(projectPath, 'vite.config.mjs')) ||
    existsSync(join(projectPath, 'vite.config.ts'))
  ) {
    return frameworkResult(FRAMEWORKS.vite, pm, projectPath);
  }

  if ('@vue/cli-service' in deps) {
    return frameworkResult(FRAMEWORKS.vueCli, pm, projectPath);
  }

  if (
    'react-scripts' in deps ||
    'react' in deps ||
    '@angular/core' in deps ||
    'vue' in deps ||
    'svelte' in deps ||
    'solid-js' in deps
  ) {
    if (existsSync(join(projectPath, 'public', 'index.html')) || existsSync(join(projectPath, 'index.html'))) {
      return frameworkResult(FRAMEWORKS.cra, pm, projectPath);
    }
  }

  if (existsSync(join(projectPath, 'index.html'))) {
    return frameworkResult(FRAMEWORKS.static, pm, projectPath);
  }

  return null;
}
