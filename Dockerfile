FROM node:22-alpine AS build

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV ELECTRON_SKIP_DOWNLOAD=1

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

ARG VITE_HOST_SERVICE_URL=
ENV VITE_HOST_SERVICE_URL=${VITE_HOST_SERVICE_URL}

RUN pnpm build:renderer

FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
