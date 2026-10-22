#!/bin/bash
# lfs-net.sh up|down|pick: this distro's own container network, so its dockerd shares nothing
# with another WSL distro's. All WSL 2 distros share one network namespace: a dockerd on
# the default docker0 would join another distro's docker0, and two dockerds managing
# iptables would fight over the same chains. So this distro's dockerd runs with
# {"bridge": "<ours>", "iptables": false} (install/distro-setup.sh writes it), and this
# script provides what Docker's iptables would: the bridge, forwarding and NAT.
#
#   pick  print a free "<bridge> <subnet>" (10.77.N.0/24, bridge lfs-10-77-N)
#   up    create the bridge from /etc/omp-layerfs/net.env and add the rules (idempotent)
#   down  remove the rules and the bridge
# Run by omp-lfs-net.service before docker.service.
set -euo pipefail
ENV=/etc/omp-layerfs/net.env

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
    for n in $(seq 0 255); do
      ip -o addr show | grep -q " 10\.77\.$n\." && continue
      ip route show | grep -q "^10\.77\.$n\." && continue
      ip link show "lfs-10-77-$n" >/dev/null 2>&1 && continue
      echo "lfs-10-77-$n 10.77.$n.0/24"; exit 0
    done
    die "no free 10.77.N.0/24"
    ;;
  up)
    # shellcheck source=/dev/null
    . "$ENV"
    gw=${LFS_SUBNET%.0/24}.1
    if ! ip link show "$LFS_BRIDGE" >/dev/null 2>&1; then
      # the subnet must still be free: another network may have taken it while we were down
      if ip route show | grep -q "^${LFS_SUBNET%/24}"; then die "$LFS_SUBNET is in use by another network; pick another (lfs-net.sh pick) into $ENV"; fi
      ip link add "$LFS_BRIDGE" type bridge
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
    rules del
    ip link del "$LFS_BRIDGE" 2>/dev/null || true
    echo "lfs-net: $LFS_BRIDGE down"
    ;;
  *) echo "usage: lfs-net.sh up|down|pick" >&2; exit 64 ;;
esac
