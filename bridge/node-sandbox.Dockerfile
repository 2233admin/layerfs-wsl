# Node Sandbox image for LayerFS Workspaces of pnpm projects (built for KATANAview: Next 16,
# pnpm 11.20). Build: docker build -t omp-lfs-node-sandbox:3 -f node-sandbox.Dockerfile .
# Workspace commands run as a non-root uid, so caches live in world-writable dirs.
FROM node:24-bookworm
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# pnpm 11 reads settings from pnpm_config_* only (npm_config_* is ignored for them).
# verify_deps_before_run=false: pnpm's workspace state records each project's absolute path
# at install time (/workspaces/<N>), and every mount gets a new /workspaces/<N>, so its
# pre-run check would reinstall the committed node_modules in every forked Workspace.
# store_dir matches the storeDir node_modules/.modules.yaml was installed with.
ENV PNPM_HOME=/opt/pnpm COREPACK_HOME=/opt/corepack NEXT_TELEMETRY_DISABLED=1 CI=1 \
    pnpm_config_verify_deps_before_run=false pnpm_config_store_dir=/tmp/pnpm-store \
    pnpm_config_package_import_method=copy
RUN mkdir -p /opt/pnpm /opt/corepack /tmp/pnpm-store && cp -r /root/.cache/node/corepack/. /opt/corepack/ 2>/dev/null || true; \
    COREPACK_HOME=/opt/corepack corepack prepare pnpm@11.20.0 --activate \
 && chmod -R a+rwX /opt/pnpm /opt/corepack /tmp/pnpm-store && node -v && pnpm -v
