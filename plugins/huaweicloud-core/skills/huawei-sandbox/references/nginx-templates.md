# Nginx Configuration Templates

Nginx is the primary serving mechanism for web apps deployed to the sandbox. Python `http.server` is a fallback when nginx is unavailable.

## Nginx Setup (sandbox)

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq nginx 2>/dev/null || true
sudo mkdir -p /etc/nginx/conf.d
```

## Template 1: SPA (with try_files fallback)

Use for: Vite, CRA, Vue CLI, Angular, VitePress, Docusaurus, Taro H5, uni-app H5

```bash
sudo tee /etc/nginx/conf.d/app.conf > /dev/null << 'NGINX_EOF'
server {
    listen <port>;
    root /workspace/<project>/<outputDir>;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}
NGINX_EOF
sudo nginx -s reload 2>/dev/null || sudo nginx
```

## Template 2: SSR Reverse Proxy

Use for: Next.js, Nuxt

```bash
sudo tee /etc/nginx/conf.d/app.conf > /dev/null << 'NGINX_EOF'
server {
    listen <publicPort>;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:<nodePort>;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }
}
NGINX_EOF
sudo nginx -s reload 2>/dev/null || sudo nginx
```

## Template 3: Static Site (no SPA routing)

Use for: Hugo, Hexo, plain static HTML

```bash
sudo tee /etc/nginx/conf.d/app.conf > /dev/null << 'NGINX_EOF'
server {
    listen <port>;
    root /workspace/<project>/<outputDir>;
    index index.html;

    location / {
        autoindex off;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}
NGINX_EOF
sudo nginx -s reload 2>/dev/null || sudo nginx
```

## Fallback: Python HTTP Server

When nginx fails to install or start:

```bash
cd /workspace/<project>/<outputDir> && nohup python3 -m http.server <port> > /tmp/http.log 2>&1 &
```

> This does **not** support SPA client-side routing. Use only for static sites or when nginx is truly unavailable.
