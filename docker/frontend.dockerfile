FROM registry.cn-hangzhou.aliyuncs.com/migo-dl/node:22-alpine AS build

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV ELECTRON_SKIP_DOWNLOAD=1

RUN npm config set registry ${NPM_REGISTRY} \
  && npm install -g pnpm@10.33.0 \
  && pnpm config set registry ${NPM_REGISTRY}

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

RUN pnpm build:renderer

FROM registry.cn-hangzhou.aliyuncs.com/migo-dl/nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
