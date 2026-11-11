# syntax=docker/dockerfile:1.7
# One image per role. Build:  docker build --target app -t tigeris-app .   and   docker build --target web -t tigeris-web .
# Base images are pinned by digest (dependabot proposes updates); scripts/release.mjs refuses a release if any reference is not.

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm typecheck && pnpm web:build

# --- API, migrations and the command-line tools. No compiler, no test tools, runs as an unprivileged user.
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS app
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
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS web
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/proxy_params.conf /etc/nginx/proxy_params.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx/security_headers.inc.template /etc/nginx/templates/security_headers.inc.template
COPY --chmod=0755 deploy/nginx/15-runtime-config.envsh /docker-entrypoint.d/15-runtime-config.envsh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV NGINX_ENVSUBST_FILTER="^(SERVER_NAME|OIDC_AUTHORITY_ORIGIN|API_UPSTREAM)$"
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
USER nginx
EXPOSE 8080 8443
