#!/bin/bash
# distro-setup.sh [--from-source]: set up omp-layerfs in an Arch Linux WSL distro, as root.
# Run from this checkout (install.ps1 does); every step is skipped when already done, so
# running it again resumes or repairs an install.
#
# It installs Docker (the distro's own dockerd, under systemd), the two LayerFS checkouts
# the bridge pins, the LayerFS core bundle (downloaded from this repository's release, or
# built with --from-source), the client image, both Sandbox images, the bridge, the page
# and the hello fixture. Paths are the bridge's and the extension's defaults.
set -euo pipefail

CORE_REV=e49d1613f075c1e945d85adb8853fbfe9e7be7eb   # core and SDK (upstream 2e5061798 + PR #409)
UI_REV=5fb68ddc1acc3163e3ac3486133bde014c5fbed3     # the page's DSH host and view code
UPSTREAM=https://github.com/Ephemeral-AI-Lab/layerfs.git
FORK=https://github.com/2233admin/layerfs.git        # holds CORE_REV until #409 is merged
FORK_BRANCH=fix/merge-binding-kind
BUNDLE_URL=https://github.com/2233admin/omp-layerfs/releases/download/core-e49d1613f/layerfs-bundle-e49d1613f.tar.gz
BUNDLE_SHA256=c0b46bf01f082e8ab973e61eb04c786c43d889460c0a656105ad4553f73519ee

SRC=/root/layerfs-upstream CORE=/root/layerfs-next BUNDLE=/root/layerfs-next-bundle UI=/root/layerfs
ROOT=/root/omp-layerfs RUNTIME_IMAGE=layerfs-352-runtime:node24
RUST_IMAGE=omp-lfs-rust-sandbox:2 NODE_IMAGE=omp-lfs-node-sandbox:3
REPO=$(cd "$(dirname "$0")/.." && pwd -P)

from_source=0
case ${1:-} in
  "") ;;
  --from-source) from_source=1 ;;
  *) echo "usage: distro-setup.sh [--from-source]" >&2; exit 64 ;;
esac
step() { printf '\n== %s\n' "$*"; }
die() { echo "distro-setup: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (wsl -u root)"
[ -f /etc/arch-release ] || die "this script sets up an Arch Linux distro"
[ "$(cat /proc/1/comm)" = systemd ] || die "systemd is not PID 1: add [boot] systemd=true to /etc/wsl.conf, run wsl --terminate <distro>, then run this again"

step "packages"
[ -s /etc/pacman.d/gnupg/trustdb.gpg ] || { pacman-key --init; pacman-key --populate archlinux; }
pacman -Syu --noconfirm --needed git docker curl
systemctl enable --now docker
docker version --format 'docker engine {{.Server.Version}}'

step "LayerFS checkouts"
[ -d "$SRC/.git" ] || git clone --quiet "$UPSTREAM" "$SRC"
git -C "$SRC" cat-file -e "$CORE_REV^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet "$FORK" "$FORK_BRANCH"
git -C "$SRC" cat-file -e "$UI_REV^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin
checkout() { # checkout <dir> <rev>: a detached worktree of $SRC at <rev>
  [ -e "$1" ] || git -C "$SRC" worktree add --quiet --detach "$1" "$2"
  [ "$(git -C "$1" rev-parse HEAD)" = "$2" ] || die "$1 exists but is not at $2; move it away and run this again"
  echo "$1 at $2"
}
checkout "$CORE" "$CORE_REV"
checkout "$UI" "$UI_REV"

step "core bundle"
if [ "$(cat "$BUNDLE/COMMIT" 2>/dev/null)" = "$CORE_REV" ] && [ -x "$BUNDLE/layerfs-daemon" ] && [ -f "$BUNDLE/layerfs.node" ]; then
  echo "$BUNDLE is built from $CORE_REV"
elif [ $from_source = 1 ]; then
  docker image inspect rust:1.85.1-bookworm >/dev/null 2>&1 || docker pull rust:1.85.1-bookworm
  bash "$REPO/bridge/build-bundle.sh" "$CORE_REV" "$CORE" "$BUNDLE"
else
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/bundle.tar.gz" "$BUNDLE_URL"
  echo "$BUNDLE_SHA256  $tmp/bundle.tar.gz" | sha256sum -c --quiet - || die "bundle download does not match its sha256"
  mkdir "$tmp/b" && tar -xzf "$tmp/bundle.tar.gz" -C "$tmp/b"
  [ "$(cat "$tmp/b/COMMIT")" = "$CORE_REV" ] || die "downloaded bundle is not built from $CORE_REV"
  rm -rf "$BUNDLE" && mv "$tmp/b" "$BUNDLE" && rm -rf "$tmp"
  echo "$BUNDLE downloaded ($CORE_REV)"
fi

step "images"
image() { docker image inspect "$1" >/dev/null 2>&1 && echo "$1 present"; }
# Dockerfiles are fed through tr: a Windows checkout may have CRLF line ends.
build() { # build <tag> <dockerfile> <context>
  tr -d '\r' < "$2" > "$3/Dockerfile.lf"
  docker build --network host -t "$1" -f "$3/Dockerfile.lf" "$3"
}
image "$RUNTIME_IMAGE" || docker build --network host -t "$RUNTIME_IMAGE" "$CORE/dsh/tools/history/runtime"
if ! image "$RUST_IMAGE"; then
  ctx=$(mktemp -d)
  # the image mirrors this distro's crate registry (see the Dockerfile); none yet is fine
  if [ -d /root/.cargo/registry ]; then cp -r /root/.cargo/registry "$ctx/registry"; else mkdir "$ctx/registry"; fi
  build "$RUST_IMAGE" "$REPO/bridge/rust-sandbox.Dockerfile" "$ctx"
  rm -rf "$ctx"
fi
if ! image "$NODE_IMAGE"; then
  ctx=$(mktemp -d)
  build "$NODE_IMAGE" "$REPO/bridge/node-sandbox.Dockerfile" "$ctx"
  rm -rf "$ctx"
fi

step "bridge, page and fixture"
mkdir -p /opt/omp-layerfs "$ROOT/ui" "$ROOT/scripts" "$ROOT/traces" "$ROOT/fixtures"
tr -d '\r' < "$REPO/bridge/lfs-bridge.sh" > /opt/omp-layerfs/lfs-bridge.sh.new
chmod 755 /opt/omp-layerfs/lfs-bridge.sh.new && mv /opt/omp-layerfs/lfs-bridge.sh.new /opt/omp-layerfs/lfs-bridge.sh
for f in server.mjs page.js index.html; do tr -d '\r' < "$REPO/ui/$f" > "$ROOT/ui/$f"; done
[ -e "$ROOT/fixtures/hello" ] || { cp -r "$REPO/fixtures/hello" "$ROOT/fixtures/hello"; find "$ROOT/fixtures/hello" -type f -exec sed -i 's/\r$//' {} +; }
echo "bridge /opt/omp-layerfs/lfs-bridge.sh, page $ROOT/ui, fixture $ROOT/fixtures/hello"

step "check"
/opt/omp-layerfs/lfs-bridge.sh projects
echo
echo "omp-layerfs is set up in this distro."
