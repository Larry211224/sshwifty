#!/bin/bash
set -euo pipefail

TARGET_OS="${1:-linux}"
TARGET_ARCH="${2:-amd64}"
OUTPUT="sshwifty-${TARGET_OS}-${TARGET_ARCH}"

echo "==> Target: ${TARGET_OS}/${TARGET_ARCH}"
echo "==> Output: ${OUTPUT}"

if [ ! -d ".tmp/dist" ] || [ -z "$(ls -A .tmp/dist 2>/dev/null)" ]; then
    echo "==> Building frontend (webpack production)..."
    npm run generate
else
    echo "==> Frontend assets found in .tmp/dist, skipping webpack build"
    echo "    (run 'npm run generate' manually if you changed frontend code)"
fi

STATIC_COUNT=$(ls application/controller/static_pages/*.go 2>/dev/null | wc -l | tr -d ' ')
if [ "$STATIC_COUNT" -eq 0 ]; then
    echo "==> Running go generate..."
    go generate ./...
else
    echo "==> Go generated files found (${STATIC_COUNT} files), skipping"
    echo "    (run 'go generate ./...' manually if frontend assets changed)"
fi

VERSION=$(git describe --always --dirty='*' --tag 2>/dev/null || echo "dev")
echo "==> Cross-compiling ${OUTPUT} (version: ${VERSION})..."

GOPROXY=https://goproxy.cn,direct \
CGO_ENABLED=0 \
GOOS="${TARGET_OS}" \
GOARCH="${TARGET_ARCH}" \
go build \
    -ldflags "-s -w -X github.com/nirui/sshwifty/application.version=${VERSION}" \
    -o "${OUTPUT}" .

echo "==> Build complete: $(ls -lh "${OUTPUT}" | awk '{print $5}') ($(file -b "${OUTPUT}"))"
echo ""
echo "==> Next steps:"
echo "   1. Copy '${OUTPUT}' to your server"
echo "   2. Copy 'Dockerfile.deploy' and 'docker-compose.yml' to your server"
echo "   3. Run 'docker compose up -d --build' on your server"
