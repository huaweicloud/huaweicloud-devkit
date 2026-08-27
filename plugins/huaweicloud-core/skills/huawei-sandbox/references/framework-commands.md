# Framework Command Mapping

Maps web frameworks to install, build, serve commands and output directories for sandbox deployment.

## SSR Frameworks

| Framework | Install       | Build           | Serve                                                       | Output Dir | Port | Nginx |
| --------- | ------------- | --------------- | ----------------------------------------------------------- | ---------- | ---- | ----- |
| Next.js   | `npm install` | `npm run build` | `nohup npm start > /tmp/app.log 2>&1 &`                     | `.next`    | 3000 | proxy |
| Nuxt      | `npm install` | `npm run build` | `nohup node .output/server/index.mjs > /tmp/app.log 2>&1 &` | `.output`  | 3000 | proxy |

## Static Site Generators (SSG)

| Framework  | Install           | Build                | Serve        | Output Dir        | Port | Nginx  |
| ---------- | ----------------- | -------------------- | ------------ | ----------------- | ---- | ------ |
| VitePress  | `npm install`     | `npm run docs:build` | nginx static | `.vitepress/dist` | 8080 | spa    |
| Docusaurus | `npm install`     | `npm run build`      | nginx static | `build`           | 8080 | spa    |
| Hugo       | (download binary) | `hugo`               | nginx static | `public`          | 8080 | static |
| Hexo       | `npm install`     | `npm run build`      | nginx static | `public`          | 8080 | static |

## SPA Frameworks

| Framework                     | Install       | Build           | Serve     | Output Dir       | Port | Nginx |
| ----------------------------- | ------------- | --------------- | --------- | ---------------- | ---- | ----- |
| Vite (React/Vue/Svelte/Solid) | `npm install` | `npm run build` | nginx SPA | `dist`           | 8080 | spa   |
| Create React App              | `npm install` | `npm run build` | nginx SPA | `build`          | 8080 | spa   |
| Vue CLI                       | `npm install` | `npm run build` | nginx SPA | `dist`           | 8080 | spa   |
| Angular                       | `npm install` | `npm run build` | nginx SPA | `dist/<project>` | 8080 | spa   |

## Cross-Platform Frameworks (H5)

| Framework | Install       | Build              | Serve     | Output Dir      | Port | Nginx |
| --------- | ------------- | ------------------ | --------- | --------------- | ---- | ----- |
| Taro      | `npm install` | `npm run build:h5` | nginx SPA | `dist`          | 8080 | spa   |
| uni-app   | `npm install` | `npm run build:h5` | nginx SPA | `dist/build/h5` | 8080 | spa   |

## Runtime Dependencies

### Sandbox Pre-installed (expected)

These tools should be available in the sandbox image. Verify with the pre-flight check in SKILL.md Step 3.

| Tool            | Min Version | Purpose                       |
| --------------- | ----------- | ----------------------------- |
| Node.js         | 22.x        | All npm-based workflows       |
| npm             | 10.x        | Package manager (fallback)    |
| nginx           | 1.26.x      | Primary static/SSR serving    |
| python3         | 3.12+       | HTTP server fallback          |
| git             | 2.45.x      | Code checkout                 |
| curl            | 8.x         | Tool downloads, health checks |
| build-essential | -           | Native module compilation     |
| pnpm            | 10.x        | Monorepo / workspace installs |

### Install on Demand

Tools that may need installation in the sandbox before building:

| Tool      | Trigger                              | Install Command                                                                      |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| yarn      | `yarn.lock` detected                 | `npm i -g yarn`                                                                      |
| Hugo      | `hugo.toml` / `config.toml` detected | Download Hugo extended binary (see below)                                            |
| DevBridge | Tunnel exposure step                 | `curl -fsSL https://res-hd.hc-cdn.cn/sharedata/hdspace/devbridge/install.sh \| bash` |

> Hugo download: `curl -fsSL https://github.com/gohugoio/hugo/releases/download/v0.140.0/hugo_extended_0.140.0_linux-amd64.tar.gz -o /tmp/hugo.tar.gz && sudo tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo && rm /tmp/hugo.tar.gz`
