# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

ARG VITE_GRAFANA_URL
ENV VITE_GRAFANA_URL=$VITE_GRAFANA_URL

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
# --shamefully-hoist forces flat node_modules so binaries resolve like npm
RUN pnpm install --no-frozen-lockfile --unsafe-perm --shamefully-hoist

COPY . .
RUN pnpm exec vite build

# ---- Production stage (nginx) ----
FROM nginx:alpine AS production

COPY --from=build /app/dist /usr/share/nginx/html

RUN cat > /etc/nginx/conf.d/default.conf << 'EOF'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    location /socket.io/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
EOF

EXPOSE 80

# ---- Development stage ----
FROM node:20-alpine AS development

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --shamefully-hoist

COPY . .

EXPOSE 5173

CMD ["pnpm", "dev", "--host"]
