FROM node:22-alpine AS build

# EPD_APT_MIRROR=0 跳过阿里云 apk；EPD_NPM_MIRROR=0 跳过 npmmirror
ARG EPD_APT_MIRROR=1
ARG EPD_NPM_MIRROR=1

RUN set -eux; \
    if [ "$EPD_APT_MIRROR" != "0" ]; then \
      sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories; \
    fi; \
    if [ "$EPD_NPM_MIRROR" != "0" ]; then \
      npm config set registry https://registry.npmmirror.com; \
    fi

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
