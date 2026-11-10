# syntax=docker/dockerfile:1.7
# One image per role. Build:  docker build --target app -t tigeris-app .   and   docker build --target web -t tigeris-web .
# The base images are pinned by tag here; pin them by digest in the client's registry when releasing.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm typecheck && pnpm web:build

# --- API, migrations and the command-line tools. No compiler, no test tools, runs as an unprivileged user.
FROM node:22-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
COPY db db
COPY data data
ENV NODE_ENV=production TIGERIS_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx", "apps/api/src/main.ts"]

# --- Web app and TLS reverse proxy. Listens on 8080 (redirect only) and 8443; the platform maps them to 80 and 443.
FROM nginx:1.27-alpine AS web
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/proxy_params.conf /etc/nginx/proxy_params.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx/security_headers.inc.template /etc/nginx/templates/security_headers.inc.template
COPY deploy/nginx/15-runtime-config.sh /docker-entrypoint.d/15-runtime-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV NGINX_ENVSUBST_FILTER="^(SERVER_NAME|OIDC_AUTHORITY_ORIGIN|API_UPSTREAM)$"
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
USER nginx
EXPOSE 8080 8443
