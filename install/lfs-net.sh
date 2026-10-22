#!/bin/bash
# lfs-net.sh up|down|pick: this distro's own container bridge, so its dockerd does not join or
# manage another WSL distro's. All WSL 2 distros share one network namespace (interfaces,
# routes, netfilter, loopback ports): a dockerd on the default docker0 would join another
# distro's docker0, and two dockerds managing iptables would fight over the same chains. So
# this distro's dockerd runs with {"bridge": "<ours>", "iptables": false} (install/distro-
# setup.sh writes it), and this script adds what Docker's iptables would for that bridge:
# forwarding and NAT rules of its own subnet. Published ports still share 127.0.0.1.
#
#   pick  print "<bridge> <subnet> <id>" for a new install: a random id, the bridge named
#         lfs-<id> and a subnet 10.64-127.x.0/24 derived from it (the first one from there no
#         address or route uses); stored in net.env, they stay this distro's while it is down
#   up    create the bridge from /etc/layerfs-wsl/net.env and add the rules (idempotent);
#         the bridge carries this distro's id as its alias, and a bridge of that name owned
#         by another distro is refused, never shared
#   down  remove the rules and the bridge, if the bridge is this distro's
# Run by lfsb-net.service before docker.service.
set -euo pipefail
ENV=/etc/layerfs-wsl/net.env

die() { echo "lfs-net: $*" >&2; exit 1; }

# The iptables variants whose FORWARD/nat chains forwarded packets pass: the default one, and
# the other when that one has tables loaded (a DROP in either would stop our traffic).
variants() {
  local v
  v=$(iptables -V)
  echo iptables
  case $v in
    *nf_tables*) [ -s /proc/net/ip_tables_names ] && command -v iptables-legacy >/dev/null && echo iptables-legacy ;;
    *) command -v iptables-nft >/dev/null && iptables-nft -w -S FORWARD 2>/dev/null | grep -q -- '-j DOCKER' && echo iptables-nft ;;
  esac
  return 0
}

rule() { # rule <add|del> <iptables> <table> <chain> <args...>
  local op=$1 ipt=$2 table=$3 chain=$4
  shift 4
  if "$ipt" -w -t "$table" -C "$chain" "$@" 2>/dev/null; then
    [ "$op" = del ] && "$ipt" -w -t "$table" -D "$chain" "$@"
  else
    [ "$op" = add ] && "$ipt" -w -t "$table" -I "$chain" 1 "$@"
  fi
  return 0
}

rules() { # rules <add|del>
  local ipt
  for ipt in $(variants); do
    rule "$1" "$ipt" filter FORWARD -i "$LFS_BRIDGE" -j ACCEPT
    rule "$1" "$ipt" filter FORWARD -o "$LFS_BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    rule "$1" "$ipt" nat POSTROUTING -s "$LFS_SUBNET" ! -o "$LFS_BRIDGE" -j MASQUERADE
  done
}

case ${1:-} in
  pick)
    h=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
    a=$((64 + 16#${h:8:2} % 64)) b=$((16#${h:10:2}))
    for i in $(seq 0 255); do
      net=10.$a.$(((b + i) % 256))
      ip -o addr show | grep -q " $net\." && continue
      ip route show | grep -q "^$net\." && continue
      echo "lfs-${h:0:8} $net.0/24 ${h:0:8}"; exit 0
    done
    die "no free 10.$a.x.0/24"
    ;;
  up)
    # shellcheck source=/dev/null
    . "$ENV"
    owner="lfsb ${LFS_ID:?no LFS_ID in $ENV}"
    gw=${LFS_SUBNET%.0/24}.1
    if ip link show "$LFS_BRIDGE" >/dev/null 2>&1; then
      have=$(cat "/sys/class/net/$LFS_BRIDGE/ifalias" 2>/dev/null || true)
      [ "$have" = "$owner" ] || die "bridge $LFS_BRIDGE exists but belongs to ${have:-something else} (all WSL 2 distros share one network); not using it"
    else
      # the subnet must still be free: another network may have taken it while we were down
      if ip route show | grep -q "^${LFS_SUBNET%/24}"; then die "$LFS_SUBNET is in use by another network; pick another (lfs-net.sh pick) into $ENV"; fi
      ip link add "$LFS_BRIDGE" type bridge
      ip link set "$LFS_BRIDGE" alias "$owner"
    fi
    ip addr show dev "$LFS_BRIDGE" | grep -q " $gw/24" || ip addr add "$gw/24" dev "$LFS_BRIDGE"
    ip link set "$LFS_BRIDGE" up
    sysctl -q -w net.ipv4.ip_forward=1
    rules add
    echo "lfs-net: $LFS_BRIDGE $LFS_SUBNET up"
    ;;
  down)
    # shellcheck source=/dev/null
    . "$ENV"
    owner="lfsb ${LFS_ID:?no LFS_ID in $ENV}"
    if ip link show "$LFS_BRIDGE" >/dev/null 2>&1; then
      have=$(cat "/sys/class/net/$LFS_BRIDGE/ifalias" 2>/dev/null || true)
      [ "$have" = "$owner" ] || die "bridge $LFS_BRIDGE belongs to ${have:-something else}, not this distro; left alone"
      ip link del "$LFS_BRIDGE"
    fi
    rules del
    echo "lfs-net: $LFS_BRIDGE down"
    ;;
  *) echo "usage: lfs-net.sh up|down|pick" >&2; exit 64 ;;
esac
