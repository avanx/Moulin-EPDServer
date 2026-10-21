FROM node:22-bookworm-slim AS build

# EPD_APT_MIRROR=0 跳过阿里云 apt；EPD_NPM_MIRROR=0 跳过 npmmirror
ARG EPD_APT_MIRROR=1
ARG EPD_NPM_MIRROR=1

RUN set -eux; \
    if [ "$EPD_APT_MIRROR" != "0" ]; then \
      sed -i \
        -e 's|deb.debian.org|mirrors.aliyun.com|g' \
        -e 's|security.debian.org|mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ "$EPD_NPM_MIRROR" != "0" ]; then \
      npm config set registry https://registry.npmmirror.com; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-bookworm-slim

ARG EPD_APT_MIRROR=1
ARG EPD_NPM_MIRROR=1
ARG EPD_VERSION=
ARG EPD_GIT_SHA=
ARG EPD_BUILD_TIME=
ENV NODE_ENV=production \
    NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" \
    EPD_VERSION=$EPD_VERSION \
    EPD_GIT_SHA=$EPD_GIT_SHA \
    EPD_BUILD_TIME=$EPD_BUILD_TIME

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./

# better-sqlite3 / argon2 需要 node-gyp（Python + 编译工具）
RUN set -eux; \
    if [ "$EPD_APT_MIRROR" != "0" ]; then \
      sed -i \
        -e 's|deb.debian.org|mirrors.aliyun.com|g' \
        -e 's|security.debian.org|mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ "$EPD_NPM_MIRROR" != "0" ]; then \
      npm config set registry https://registry.npmmirror.com; \
      export npm_config_registry=https://registry.npmmirror.com; \
      export PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
      fonts-dejavu-core \
      fonts-wqy-microhei \
    && npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/server/dist ./dist
COPY packages /app/packages

EXPOSE 8000
CMD ["node", "dist/index.js"]
