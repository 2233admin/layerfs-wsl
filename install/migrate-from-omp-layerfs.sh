#!/bin/bash
# migrate-from-omp-layerfs.sh: move a distro's install of omp-layerfs (this project's old name)
# to layerfs-bridge, as root, after distro-setup.sh has installed /opt/layerfs-bridge.
# distro-setup.sh runs it when it finds /opt/omp-layerfs/lfs-bridge.sh. Safe to run again:
# it resumes where it stopped.
#
# Per project (each Store volume omp-lfs-<project>-store), with the old bridge:
#   1. note the client's Sandbox image and whether it has a page (kept in
#      /root/layerfs-bridge/migrate/<project>.env, so a rerun still knows them)
#   2. stop its page; list its Sandboxes, which reclaims the idle closed ones; refuse while a
#      Sandbox runs or a sandbox.record remains (the record names the old container and
#      volume, and the Store would not open cleanly under the new names)
#   3. remove the old client container, so the Store is closed while it is copied
#   4. copy the volume to lfsb-<project>-store, compare file count and bytes, and mark it
#      done (migrate/<project>.done); a copy without the mark is made again
# Only when every project is done: move /root/omp-layerfs into /root/layerfs-bridge, tag the
# images omp-lfs-* as lfsb-*, start each client again with the new bridge (and its page) and
# remove /opt/omp-layerfs. The old volumes are kept: `docker volume rm omp-lfs-<project>-store`
# once the projects work under the new names.
set -euo pipefail
OLD=/opt/omp-layerfs/lfs-bridge.sh NEW=/opt/layerfs-bridge/lfs-bridge.sh
OLD_ROOT=/root/omp-layerfs NEW_ROOT=/root/layerfs-bridge STATE=/root/layerfs-bridge/migrate
RUNTIME_IMAGE=layerfs-352-runtime:node24
die() { echo "migrate: $*" >&2; exit 1; }
in_volume() { docker run --rm --network none -v "$1":/s:ro "$RUNTIME_IMAGE" sh -c "$2"; }

[ -x "$OLD" ] || { echo "migrate: no omp-layerfs install here"; exit 0; }
[ -x "$NEW" ] || die "$NEW is not installed; run install/distro-setup.sh first"
mkdir -p "$STATE"

projects=$(docker volume ls --format '{{.Name}}' | sed -n 's/^omp-lfs-\(.*\)-store$/\1/p')
for p in $projects; do
  old=omp-lfs-$p from=omp-lfs-$p-store to=lfsb-$p-store
  [ -f "$STATE/$p.done" ] && { echo "== $p: copied before"; continue; }
  echo "== $p"
  if docker inspect "$old" >/dev/null 2>&1 && [ ! -f "$STATE/$p.env" ]; then
    img=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$old" | sed -n 's/^LAYERFS_IMAGE=//p')
    pg=0
    [ -f "$OLD_ROOT/ui-ports" ] && awk -v p="$p" '$1 == p { f = 1 } END { exit !f }' "$OLD_ROOT/ui-ports" && pg=1
    printf 'IMAGE=%s\nPAGE=%s\n' "$img" "$pg" > "$STATE/$p.env"
  fi
  if docker inspect "$old" >/dev/null 2>&1; then
    "$OLD" ui-stop "$p" </dev/null >/dev/null 2>&1 || true
    install -m 644 /dev/stdin "$OLD_ROOT/scripts/migrate-reclaim.mjs" <<'EOF'
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const { LayerFSOperator } = await import(process.env.DSH_LAYERFS_OPERATOR);
const lf = new LayerFS(process.env.DSH_LAYERFS_PROJECT);
try { console.log(`Sandboxes still open: ${JSON.stringify(await new LayerFSOperator(lf).sandbox.list())}`); } finally { await lf.close(); }
EOF
    # </dev/null: the old bridge's docker exec -i would read the rest of a piped script
    "$OLD" script "$p" "$p.migrate" "$OLD_ROOT/scripts/migrate-reclaim.mjs" </dev/null
    rm -f "$OLD_ROOT/scripts/migrate-reclaim.mjs"
  fi
  running=$(docker ps --filter "volume=$from" --format '{{.Names}}' | grep -vx "$old" || true)
  [ -z "$running" ] || die "$p: Sandboxes still run ($running); unmount their Workspaces, wait two minutes and run this again"
  records=$(in_volume "$from" 'ls /s/sdk-home/*/sandboxes/*/sandbox.record 2>/dev/null' || true)
  [ -z "$records" ] || die "$p: Sandbox records remain ($records); unmount its Workspaces, wait two minutes and run this again"
  docker rm -f "$old" >/dev/null 2>&1 || true
  docker ps -aq --filter "volume=$from" | xargs -r docker rm >/dev/null
  # a copy without the mark is incomplete: it goes, or nothing is copied over it
  if docker volume inspect "$to" >/dev/null 2>&1; then
    docker volume rm "$to" >/dev/null || die "$p: cannot remove the incomplete copy $to (in use?)"
  fi
  docker run --rm --network none -v "$from":/from:ro -v "$to":/to "$RUNTIME_IMAGE" sh -c 'cp -a /from/. /to/'
  a=$(in_volume "$from" 'find /s | wc -l; du -sb /s | cut -f1' | tr '\n' ' ')
  b=$(in_volume "$to" 'find /s | wc -l; du -sb /s | cut -f1' | tr '\n' ' ')
  [ "$a" = "$b" ] || die "$p: the copy differs (entries, bytes: $from $a, $to $b)"
  touch "$STATE/$p.done"
  echo "$from copied to $to (entries, bytes: $b)"
done

echo "== state and images"
if [ -d "$OLD_ROOT" ]; then
  for d in traces scripts exports; do
    [ -d "$OLD_ROOT/$d" ] && mkdir -p "$NEW_ROOT/$d" && cp -a "$OLD_ROOT/$d/." "$NEW_ROOT/$d/"
  done
  [ -f "$OLD_ROOT/ui-ports" ] && [ ! -f "$NEW_ROOT/ui-ports" ] && cp "$OLD_ROOT/ui-ports" "$NEW_ROOT/ui-ports"
  rm -rf "$OLD_ROOT"
  echo "$OLD_ROOT moved into $NEW_ROOT"
fi
for t in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^omp-lfs-' || true); do
  docker tag "$t" "${t/omp-lfs-/lfsb-}" && docker rmi "$t" >/dev/null && echo "image $t is now ${t/omp-lfs-/lfsb-}"
done

for p in $projects; do
  [ -f "$STATE/$p.env" ] || { echo "$p: its old client was gone; run: $NEW up $p <image>"; continue; }
  IMAGE= PAGE=0
  . "$STATE/$p.env"
  tag=$(docker image inspect --format '{{join .RepoTags "\n"}}' "$IMAGE" 2>/dev/null | grep -m1 '^lfsb-' || true)
  [ -n "$tag" ] || { echo "$p: no lfsb-* tag for its image $IMAGE; run: $NEW up $p <image>"; continue; }
  "$NEW" up "$p" "$tag" </dev/null
  if [ "$PAGE" = 1 ]; then "$NEW" ui "$p" </dev/null; fi
done
# done only when every noted project's new client runs; else the notes stay for a rerun
for p in $projects; do
  [ -f "$STATE/$p.env" ] || continue
  [ "$(docker inspect --format '{{.State.Running}}' "lfsb-$p" 2>/dev/null)" = true ] \
    || die "$p: its new client lfsb-$p does not run; fix that and run this again"
done
rm -rf /opt/omp-layerfs "$STATE"
echo "migrated. Old Store volumes kept: $(for p in $projects; do printf 'omp-lfs-%s-store ' "$p"; done)"
