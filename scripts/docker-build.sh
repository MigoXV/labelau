#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION="${1:-0.2.0a1}"
PUSH_MODE="${2:---push}"

REGISTRY_PREFIX="${REGISTRY_PREFIX:-registry.cn-hangzhou.aliyuncs.com/migo-dl}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
FRONTEND_IMAGE_NAME="${FRONTEND_IMAGE_NAME:-labelau-frontend}"
SERVICE_IMAGE_NAME="${SERVICE_IMAGE_NAME:-labelau-service}"

FRONTEND_IMAGE="${REGISTRY_PREFIX}/${FRONTEND_IMAGE_NAME}:${VERSION}"
SERVICE_IMAGE="${REGISTRY_PREFIX}/${SERVICE_IMAGE_NAME}:${VERSION}"

echo "构建 LabelAU Docker 镜像"
echo "版本: ${VERSION}"
echo "前端镜像: ${FRONTEND_IMAGE}"
echo "服务镜像: ${SERVICE_IMAGE}"
echo "NPM 源: ${NPM_REGISTRY}"

cd "${ROOT_DIR}"

docker build \
  -f docker/frontend.dockerfile \
  --build-arg NPM_REGISTRY="${NPM_REGISTRY}" \
  -t "${FRONTEND_IMAGE}" \
  .

docker build \
  -f docker/service.dockerfile \
  --build-arg NPM_REGISTRY="${NPM_REGISTRY}" \
  -t "${SERVICE_IMAGE}" \
  .

if [[ "${PUSH_MODE}" == "--push" ]]; then
  docker push "${FRONTEND_IMAGE}"
  docker push "${SERVICE_IMAGE}"
else
  echo "已跳过推送；传入 --push 可推送到远端仓库。"
fi
