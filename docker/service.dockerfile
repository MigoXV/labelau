FROM registry.cn-hangzhou.aliyuncs.com/migo-dl/node:22-alpine AS build

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV ELECTRON_SKIP_DOWNLOAD=1

RUN npm config set registry ${NPM_REGISTRY} \
  && npm install -g pnpm@10.33.0 \
  && pnpm config set registry ${NPM_REGISTRY}

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.node.json ./
COPY src ./src

RUN pnpm install --frozen-lockfile
RUN pnpm build:node

FROM registry.cn-hangzhou.aliyuncs.com/migo-dl/node:22-alpine AS runtime

WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV NODE_ENV=production

RUN npm config set registry ${NPM_REGISTRY} \
  && npm install -g pnpm@10.33.0 \
  && pnpm config set registry ${NPM_REGISTRY}

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY --from=build /app/dist-node ./dist-node

EXPOSE 3777

CMD ["node", "dist-node/host-service/server.js"]
