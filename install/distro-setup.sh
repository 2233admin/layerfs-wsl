#!/bin/bash
# distro-setup.sh [--from-source]: set up layerfs-wsl in an Arch Linux or Ubuntu (22.04 or
# later; tested on 24.04) WSL distro, as root.
# Run from this checkout (install.ps1 does); every step is skipped when already done, so
# running it again resumes or repairs an install.
#
# It installs Docker (the distro's own dockerd, under systemd) on the distro's own container
# network (install/lfs-net.sh), the two LayerFS checkouts lfs-wsl.sh pins, the LayerFS core
# bundle (downloaded from this repository's release, or built with --from-source), the client
# image, both Sandbox images, lfs-wsl.sh, the page and the hello fixture. Paths are
# lfs-wsl.sh's and the extension's defaults.
set -euo pipefail

CORE_REV=1aa56ece78e2ecd71b46cf07076100345df47239   # core and SDK (upstream main, includes PR #409)
UI_REV=5fb68ddc1acc3163e3ac3486133bde014c5fbed3     # the page's DSH host and view code
UPSTREAM=https://github.com/Ephemeral-AI-Lab/layerfs.git
BUNDLE_URL=https://github.com/2233admin/layerfs-wsl/releases/download/core-1aa56ece7/layerfs-bundle-1aa56ece7.tar.gz
BUNDLE_SHA256=bdb54a6a94e780eb5892c83289f18d60612accff43ec4998a7ceb99cc639dcba

SRC=/root/layerfs-upstream CORE=/root/layerfs-next BUNDLE=/root/layerfs-next-bundle UI=/root/layerfs
ROOT=/root/layerfs-wsl RUNTIME_IMAGE=layerfs-352-runtime:node24
RUST_IMAGE=lfsb-rust-sandbox:2 NODE_IMAGE=lfsb-node-sandbox:3
REPO=$(cd "$(dirname "$0")/.." && pwd -P)

from_source=0
for a in "$@"; do
  case $a in
    --from-source) from_source=1 ;;
    *) echo "usage: distro-setup.sh [--from-source]" >&2; exit 64 ;;
  esac
done
step() { printf '\n== %s\n' "$*"; }
die() { echo "distro-setup: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (wsl -u root)"
[ "$(uname -m)" = x86_64 ] || die "x86_64 only: the core bundle and the Sandbox images are built for it"
[ "$(cat /proc/1/comm)" = systemd ] || die "systemd is not PID 1: add [boot] systemd=true to /etc/wsl.conf, run wsl --terminate <distro>, then run this again"
. /etc/os-release
case $ID in
  arch) ;;
  ubuntu) [ "${VERSION_ID%%.*}" -ge 22 ] || die "Ubuntu $VERSION_ID: 22.04 or later is needed" ;;
  *) die "this script sets up an Arch Linux or Ubuntu distro, not $ID" ;;
esac

step "packages"
if [ "$ID" = arch ]; then
  [ -s /etc/pacman.d/gnupg/trustdb.gpg ] || { pacman-key --init; pacman-key --populate archlinux; }
  pacman -Syu --noconfirm --needed git curl iproute2 iptables
else
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  apt() { apt-get -o DPkg::Lock::Timeout=600 -q "$@"; }
  apt update
  apt install -y ca-certificates curl git iproute2 iptables
fi

# All WSL 2 distros share one network namespace, so a dockerd on the default docker0 would
# join another distro's docker0, and two dockerds managing iptables would fight over the same
# chains. This distro's dockerd gets a bridge of its own and leaves iptables to lfs-net.sh.
# The network is set up before Docker is installed: Ubuntu's package starts dockerd at once.
step "container network"
# an install under the name layerfs-bridge keeps its network: its net.env moves with the name
if [ -d /etc/layerfs-bridge ] && [ ! -e /etc/layerfs-wsl ]; then
  mv /etc/layerfs-bridge /etc/layerfs-wsl
  echo "network of the layerfs-bridge install carried over"
fi
install -D -m 755 <(tr -d '\r' < "$REPO/install/lfs-net.sh") /opt/layerfs-wsl/lfs-net.sh
if [ -f /etc/omp-layerfs/net.env ] && [ ! -f /etc/layerfs-wsl/net.env ]; then
  # an install under this project's old name (omp-layerfs) with its own network: same bridge
  # and subnet; its unit gives way to lfsb-net.service and the bridge's owner alias is renamed
  systemctl disable omp-lfs-net.service 2>/dev/null || true
  rm -f /etc/systemd/system/omp-lfs-net.service /etc/systemd/system/docker.service.d/omp-lfs-net.conf
  install -D -m 644 /etc/omp-layerfs/net.env /etc/layerfs-wsl/net.env && rm -rf /etc/omp-layerfs
  . /etc/layerfs-wsl/net.env
  if [ "$(cat "/sys/class/net/$LFS_BRIDGE/ifalias" 2>/dev/null)" = "omp-lfs $LFS_ID" ]; then
    ip link set "$LFS_BRIDGE" alias "lfsb $LFS_ID"
  fi
  echo "network of the omp-layerfs install carried over: $LFS_BRIDGE $LFS_SUBNET"
elif [ -f /etc/layerfs-wsl/net.env ]; then
  echo "kept: $(tr '\n' ' ' < /etc/layerfs-wsl/net.env)"
elif [ -e /etc/docker/daemon.json ]; then
  die "/etc/docker/daemon.json exists and was not written by this script; refusing to change a Docker setup it does not own (use a distro of its own)"
elif [ -d /var/lib/docker/network ]; then
  # an install from before lfs-net.sh, on docker0; moving it would change the bridge under its Sandboxes
  echo "this distro's dockerd already runs on docker0 (an older install); left as it is"
else
  read -r bridge subnet id < <(/opt/layerfs-wsl/lfs-net.sh pick)
  install -D -m 644 /dev/stdin /etc/layerfs-wsl/net.env <<<"LFS_BRIDGE=$bridge
LFS_SUBNET=$subnet
LFS_ID=$id"
  install -D -m 644 /dev/stdin /etc/docker/daemon.json <<<"{\"bridge\": \"$bridge\", \"iptables\": false, \"ip6tables\": false}"
  echo "bridge $bridge, subnet $subnet"
fi
if [ -f /etc/layerfs-wsl/net.env ]; then
  cat > /etc/systemd/system/lfsb-net.service <<'EOF'
[Unit]
Description=layerfs-wsl container network (bridge, forwarding, NAT)
Before=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/layerfs-wsl/lfs-net.sh up
ExecStop=/opt/layerfs-wsl/lfs-net.sh down
[Install]
WantedBy=multi-user.target
EOF
  install -D -m 644 /dev/stdin /etc/systemd/system/docker.service.d/lfsb-net.conf <<'EOF'
[Unit]
Requires=lfsb-net.service
After=lfsb-net.service
EOF
  systemctl daemon-reload
  systemctl enable --now lfsb-net.service
fi

step "docker"
if [ "$ID" = arch ]; then
  pacman -S --noconfirm --needed docker
elif ! command -v dockerd >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt update
  apt install -y docker-ce docker-ce-cli containerd.io
fi
systemctl enable --now docker
api=$(docker version --format '{{.Server.APIVersion}}')
docker version --format 'docker engine {{.Server.Version}}, API {{.Server.APIVersion}}'
[ "$(printf '%s\n1.54\n' "$api" | sort -V | head -1)" = 1.54 ] || die "Docker API $api: the LayerFS core needs 1.54 or later"

# Clients made for another core or other paths than this install's (an older core, or the name
# layerfs-bridge, whose state folder moves below) are made again for them. Before anything
# changes: none of their projects may have a running Sandbox, and the pages that answer now are
# noted, to be started again (a port in ui-ports alone does not mean the page runs). The clients
# are removed before the checkout and bundle change under them (their Store volumes stay); the
# list is kept in $PENDING until they are up again, so a run that stops midway resumes them.
step "clients made for another core"
want="$BUNDLE@$CORE_REV $CORE $UI $ROOT" old_root=$ROOT
PENDING=/var/lib/layerfs-wsl/pending-clients
[ ! -d /root/layerfs-bridge ] || old_root=/root/layerfs-bridge
mkdir -p "$(dirname "$PENDING")" && touch "$PENDING"
for p in $(docker ps -a --filter label=lfsb.project --format '{{.Label "lfsb.project"}}'); do
  have=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "lfsb-$p" | sed -n 's/^LFSB_CORE=//p')
  [ "$have" != "$want" ] || continue
  busy=$(docker ps --filter "volume=lfsb-$p-store" --format '{{.Names}}' | grep -vx "lfsb-$p" || true)
  [ -z "$busy" ] || die "$p: Sandboxes still run ($(echo $busy)); unmount their Workspaces, wait two minutes and run this again"
  id=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "lfsb-$p" | sed -n 's/^LAYERFS_IMAGE=//p')
  tag=$(docker image inspect --format '{{join .RepoTags "\n"}}' "$id" 2>/dev/null | grep -m1 '^lfsb-' || true)
  [ -n "$tag" ] || die "$p: its Sandbox image $id has no lfsb-* tag; tag it (docker tag $id lfsb-<kind>-sandbox:<n>) and run this again"
  page=0 port=$(awk -v p="$p" '$1 == p { print $2; exit }' "$old_root/ui-ports" 2>/dev/null || true)
  if [ -n "$port" ] && curl -fsS -m 2 "http://127.0.0.1:$port/bridge/whoami" 2>/dev/null | grep -q "\"project\":\"$p\""; then page=1; fi
  awk -v p="$p" '$1 == p { f = 1 } END { exit !f }' "$PENDING" || echo "$p $tag $page" >> "$PENDING"
done
while read -r p tag page; do
  if docker inspect "lfsb-$p" >/dev/null 2>&1; then
    docker rm -f "lfsb-$p" >/dev/null && echo "client lfsb-$p removed, to be made again ($tag)"
  fi
done < "$PENDING"

step "LayerFS checkouts"
[ -d "$SRC/.git" ] || git clone --quiet "$UPSTREAM" "$SRC"
git -C "$SRC" cat-file -e "$CORE_REV^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin
git -C "$SRC" cat-file -e "$UI_REV^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin
checkout() { # checkout <dir> <rev>: a detached worktree of $SRC at <rev>; a clean one is moved to <rev>
  [ -e "$1" ] || git -C "$SRC" worktree add --quiet --detach "$1" "$2"
  if [ "$(git -C "$1" rev-parse HEAD)" != "$2" ]; then
    [ -z "$(git -C "$1" status --porcelain)" ] || die "$1 has local changes and is not at $2; move it away and run this again"
    git -C "$1" checkout --quiet --detach "$2"
  fi
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

step "bridge, page and fixture"
# (the clients this install remakes were noted and removed in "clients made for another core")
if [ -d /root/layerfs-bridge ]; then
  [ ! -e "$ROOT" ] || die "both /root/layerfs-bridge and $ROOT exist; merge them by hand and run this again"
  mv /root/layerfs-bridge "$ROOT" && echo "/root/layerfs-bridge moved to $ROOT"
fi
rm -rf /opt/layerfs-bridge
mkdir -p /opt/layerfs-wsl "$ROOT/ui" "$ROOT/scripts" "$ROOT/traces" "$ROOT/fixtures"
tr -d '\r' < "$REPO/bridge/lfs-wsl.sh" > /opt/layerfs-wsl/lfs-wsl.sh.new
chmod 755 /opt/layerfs-wsl/lfs-wsl.sh.new && mv /opt/layerfs-wsl/lfs-wsl.sh.new /opt/layerfs-wsl/lfs-wsl.sh
for f in server.mjs page.js index.html; do tr -d '\r' < "$REPO/ui/$f" > "$ROOT/ui/$f"; done
[ -e "$ROOT/fixtures/hello" ] || { cp -r "$REPO/fixtures/hello" "$ROOT/fixtures/hello"; find "$ROOT/fixtures/hello" -type f -exec sed -i 's/\r$//' {} +; }
echo "command /opt/layerfs-wsl/lfs-wsl.sh, page $ROOT/ui, fixture $ROOT/fixtures/hello"
while read -r p tag page; do
  /opt/layerfs-wsl/lfs-wsl.sh up "$p" "$tag" </dev/null
  [ "$page" = 0 ] || /opt/layerfs-wsl/lfs-wsl.sh ui "$p" </dev/null
  awk -v p="$p" '$1 != p' "$PENDING" > "$PENDING.new" && mv "$PENDING.new" "$PENDING"
done < <(cat "$PENDING")

# an install of this project under its old name (omp-layerfs): its projects move to the new names
if [ -x /opt/omp-layerfs/lfs-bridge.sh ]; then
  step "migrate from omp-layerfs"
  bash "$REPO/install/migrate-from-omp-layerfs.sh"
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

step "check"
/opt/layerfs-wsl/lfs-wsl.sh projects
echo
echo "layerfs-wsl is set up in this distro."
