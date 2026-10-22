#!/bin/bash
# Build the LayerFS Linux bundle the bridge runs (layerfs-daemon + layerfs.node + COMMIT),
# per LayerFS dsh/README "The Linux build": a release build in rust:1.85.1-bookworm, so the
# addon needs glibc 2.34 at most (the client image has it).
#   build-bundle.sh <rev> [checkout] [bundle]
# defaults: checkout /root/layerfs-next (a worktree of /root/layerfs-upstream at <rev>),
# bundle /root/layerfs-next-bundle. Cargo's target dir is the volume layerfs-next-target and
# the registry the volume layerfs-cargo, both reused by later builds. JOBS (default 8) caps
# cargo's jobs. Containers use host networking, so nothing depends on Docker's bridge NAT.
set -euo pipefail
JOBS=${JOBS:-8}
REV=${1:?usage: build-bundle.sh <rev> [checkout] [bundle]}
C=${2:-/root/layerfs-next} B=${3:-/root/layerfs-next-bundle}
[ -d "$C" ] || git -C /root/layerfs-upstream worktree add --detach "$C" "$REV"
[ "$(git -C "$C" rev-parse HEAD)" = "$(git -C "$C" rev-parse "$REV^{commit}")" ] || { echo "checkout $C is not at $REV" >&2; exit 1; }
mkdir -p "$C/core/target/cluster2-linux"
docker volume inspect layerfs-next-target >/dev/null 2>&1 || docker volume create layerfs-next-target >/dev/null
docker run --rm --network host -v "$C":/work:ro -v layerfs-cargo:/usr/local/cargo/registry -w /work \
  rust:1.85.1-bookworm cargo fetch --manifest-path core/Cargo.toml --locked
docker run --rm --network none -v "$C":/work:ro -v layerfs-next-target:/work/core/target/cluster2-linux \
  -v layerfs-cargo:/usr/local/cargo/registry:ro -e CARGO_TARGET_DIR=/work/core/target/cluster2-linux -w /work \
  rust:1.85.1-bookworm cargo build --manifest-path core/Cargo.toml --offline --locked --release -j "$JOBS" \
  -p layerfs-node --lib -p layerfs-daemon --bins
rm -rf "$B.tmp"; mkdir -p "$B.tmp"
docker run --rm --network none -v layerfs-next-target:/t:ro -v "$B.tmp":/out rust:1.85.1-bookworm sh -c \
  "cp /t/release/layerfs-daemon /out/ && cp /t/release/liblayerfs_node.so /out/layerfs.node"
git -C "$C" rev-parse HEAD > "$B.tmp/COMMIT"
rm -rf "$B"; mv "$B.tmp" "$B"
echo "bundle $B built from $(cat "$B/COMMIT")"
