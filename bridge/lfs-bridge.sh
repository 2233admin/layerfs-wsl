#!/bin/bash
# lfs-bridge.sh: OMP's bridge to a LayerFS project in this WSL distro.
#
# One long-lived SDK client container per project (omp-lfs-<project>), set up
# like /root/bench/lfs_run.sh: the LayerFS bundle and checkout at their own
# paths, the Docker socket, host networking and the project's Store volume.
# Every `cli`/`script` call is one `docker exec` in it with the DSH_LAYERFS_*
# environment DSH gives an agent's bash call, so lfs.js, SDK scripts and the
# SKILL.md examples work unchanged. The inner command's exit code and output
# are passed through.
#
# usage:
#   lfs-bridge.sh up     <project> <image>
#   lfs-bridge.sh init   <project> <image> <linux-src-dir>
#   lfs-bridge.sh cli    <project> <trace-id> -- <lfs.js args...>   (stdin passed through)
#   lfs-bridge.sh script <project> <trace-id> <script-path>          (under $OMP_LFS_ROOT/scripts)
#   lfs-bridge.sh down   <project>
#   lfs-bridge.sh ui     <project> [port]      (the LayerFS page, default port 8787)
#   lfs-bridge.sh ui-stop <project>
#
# env: LFS_TRACE_STEP labels this call's SDK trace lines (DSH_LAYERFS_TRACE_STEP).
set -euo pipefail

BUNDLE=${OMP_LFS_BUNDLE:-/root/layerfs-linux-build}
LAYERFS=${OMP_LFS_CHECKOUT:-/root/layerfs}
ROOT=${OMP_LFS_ROOT:-/root/omp-layerfs}
RUNTIME_IMAGE=${OMP_LFS_RUNTIME_IMAGE:-layerfs-352-runtime:node24}
SDK=file://$LAYERFS/sdk/js/src/index.js
OPERATOR=file://$LAYERFS/sdk/js/operator/index.js
CLI=$LAYERFS/dsh/packages/host/src/lfs.js
SKILL=$LAYERFS/.agents/skills/layerfs-js-sdk/SKILL.md

die() { echo "lfs-bridge: $*" >&2; exit 64; }
usage() { sed -n '12,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }

check_project() {
  [[ $1 =~ ^[a-z0-9]([a-z0-9_.-]{0,61}[a-z0-9])?$ ]] || die "bad project name '$1' (a-z 0-9 _ - ., 1-63 chars, letter/digit at both ends)"
}
check_trace() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "bad trace id '$1'"
}
client() { echo "omp-lfs-$1"; }
image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || die "image '$1' not found in this distro's Docker"
}

# up <project> <image>: the project's client container, running. Idempotent;
# a client made for another image is recreated (the Store volume stays).
cmd_up() {
  [ $# -eq 2 ] || usage
  local project=$1 image=$2 name sbx runtime have
  check_project "$project"
  name=$(client "$project")
  sbx=$(image_id "$image")
  runtime=$(image_id "$RUNTIME_IMAGE")
  if have=$(docker inspect --format '{{index .Config.Labels "omp-lfs.image"}} {{.Image}}' "$name" 2>/dev/null); then
    if [ "$have" = "$sbx $runtime" ]; then
      [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || docker start "$name" >/dev/null
      echo "client $name up (image $image)"
      return
    fi
    docker rm -f "$name" >/dev/null
  fi
  mkdir -p "$ROOT/scripts" "$ROOT/traces"
  docker volume inspect "$name-store" >/dev/null 2>&1 || docker volume create "$name-store" >/dev/null
  docker run -d --name "$name" --pull never --init \
    --label omp-lfs.project="$project" --label omp-lfs.image="$sbx" \
    --mount type=bind,src="$BUNDLE",dst="$BUNDLE",readonly \
    --mount type=bind,src="$LAYERFS",dst="$LAYERFS",readonly \
    --mount type=bind,src="$ROOT",dst="$ROOT" \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount type=volume,src="$name-store",dst=/layerfs-store,volume-nocopy \
    -e LAYERFS_HOME=/layerfs-store/sdk-home -e LAYERFS_STORE_PATH=/layerfs-store/global/store.sqlite \
    -e LAYERFS_DOCKER=/var/run/docker.sock -e LAYERFS_IMAGE="$sbx" -e LAYERFS_VOLUME="$name-store" \
    -e LAYERFS_DAEMON="$BUNDLE/layerfs-daemon" -e LAYERFS_NATIVE="$BUNDLE/layerfs.node" \
    -e LAYERFS_CONTAINER_PREFIX="$name-" -e LAYERFS_CONSTRUCTION_WORKERS=1 \
    -e LAYERFS_DAEMON_HOST=127.0.0.1 \
    --network host -w "$BUNDLE" --entrypoint /bin/sh "$runtime" \
    -c 'umask 077; mkdir -p /layerfs-store/sdk-home /layerfs-store/global; exec sleep infinity' >/dev/null
  echo "client $name up (image $image, Store volume $name-store)"
}

# The running client of <project>, started again when stopped.
running_client() {
  local name
  name=$(client "$1")
  case $(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo missing) in
    true) ;;
    false) docker start "$name" >/dev/null ;;
    *) die "project '$1' has no client container; run: lfs-bridge.sh init $1 <image> <src-dir> (or up)" ;;
  esac
  echo "$name"
}

# docker exec in the client with an agent's DSH_LAYERFS_* environment.
exec_agent() {
  local project=$1 trace=$2 name
  shift 2
  name=$(running_client "$project")
  local env=(-e DSH_LAYERFS_PROJECT="$project" -e DSH_LAYERFS_SDK="$SDK" -e DSH_LAYERFS_OPERATOR="$OPERATOR"
    -e DSH_LAYERFS_CLI="$CLI" -e DSH_LAYERFS_SKILL="$SKILL"
    -e DSH_LAYERFS_TRACE="$ROOT/traces/$trace.jsonl" -e DSH_LAYERFS_TRACE_START=1)
  [ -z "${LFS_TRACE_STEP:-}" ] || env+=(-e DSH_LAYERFS_TRACE_STEP="$LFS_TRACE_STEP")
  exec docker exec -i -w "$BUNDLE" "${env[@]}" "$name" "$@"
}

cmd_init() {
  [ $# -eq 3 ] || usage
  local project=$1 image=$2 src=$3 name tmp
  [ -d "$src" ] || die "source folder '$src' not found in this distro"
  cmd_up "$project" "$image"
  name=$(client "$project")
  tmp=/tmp/omp-init-$project
  docker exec "$name" rm -rf "$tmp"
  docker cp -q "$src/." "$name:$tmp"
  # LayerFS commits build output (target/, node_modules/) with the sources; without a
  # /.lww rule, two Branches that both built conflict on those files at merge. The
  # upstream default is to merge every .gitignore path newer-wins.
  docker exec "$name" sh -c '[ -e "$1/.lww" ] || printf "%%include .gitignore\n" >"$1/.lww"' sh "$tmp"
  docker exec "$name" sh -c '[ -e "$1/.gitignore" ]' sh "$tmp" \
    || echo "lfs-bridge: $src has no .gitignore; /.lww includes nothing until one is added" >&2
  local rc=0
  docker exec -w "$BUNDLE" -e P="$project" -e SRC="$tmp" -e SDK="$SDK" "$name" node --input-type=module -e '
    const { LayerFS } = await import(process.env.SDK);
    const lf = new LayerFS(process.env.P);
    try {
      const r = await lf.project.init(process.env.SRC);
      console.log(`${r.kind} project ${process.env.P}, main Layer ${r.layer}`);
    } catch (e) {
      if (e.code !== "Exists") { console.error(`${e.code ?? "Error"}: ${e.message}`); process.exitCode = 2; }
      else console.log(`project ${process.env.P} already exists; nothing to do`);
    } finally { await lf.close(); }' || rc=$?
  docker exec "$name" rm -rf "$tmp"
  return $rc
}

cmd_cli() {
  [ $# -ge 3 ] && [ "$3" = -- ] || usage
  local project=$1 trace=$2
  shift 3
  check_project "$project"; check_trace "$trace"
  exec_agent "$project" "$trace" node "$CLI" "$@"
}

cmd_script() {
  [ $# -eq 3 ] || usage
  local project=$1 trace=$2 path
  check_project "$project"; check_trace "$trace"
  path=$(realpath -e "$3" 2>/dev/null) || die "script '$3' not found"
  [[ $path == "$ROOT/scripts/"* ]] || die "script must live under $ROOT/scripts"
  exec_agent "$project" "$trace" node "$path"
}

cmd_down() {
  [ $# -eq 1 ] || usage
  check_project "$1"
  local name
  name=$(client "$1")
  docker stop "$name" >/dev/null 2>&1 || die "no client container $name"
  echo "client $name stopped (Store volume $name-store kept)"
}

# The page's server (ui/server.mjs, installed under $ROOT/ui) runs detached in
# the client; its pid, port and log are in the client's /tmp.
UI_PID=/tmp/omp-lfs-ui.pid UI_PORT=/tmp/omp-lfs-ui.port UI_LOG=/tmp/omp-lfs-ui.log
# The pid of the client's running page server, if any.
ui_pid() {
  docker exec "$1" sh -c "p=\$(cat $UI_PID 2>/dev/null) && grep -q server.mjs /proc/\$p/cmdline 2>/dev/null && echo \$p" || true
}

# ui <project> [port]: the project's LayerFS page, started when it is not
# running on that port (one page per client; another port restarts it).
cmd_ui() {
  [ $# -ge 1 ] && [ $# -le 2 ] || usage
  local project=$1 port=${2:-8787} name pid
  check_project "$project"
  [[ $port =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "bad port '$port'"
  [ -f "$ROOT/ui/server.mjs" ] || die "$ROOT/ui/server.mjs is not installed (see README: Install)"
  name=$(running_client "$project")
  pid=$(ui_pid "$name")
  if [ -n "$pid" ]; then
    if [ "$(docker exec "$name" cat $UI_PORT 2>/dev/null)" = "$port" ]; then
      echo "LayerFS page of $project already running: http://localhost:$port"
      return
    fi
    cmd_ui_stop "$project" >/dev/null
  fi
  docker exec -d -w "$BUNDLE" "$name" sh -c "echo \$\$ > $UI_PID; echo $port > $UI_PORT; exec node $ROOT/ui/server.mjs $project $port > $UI_LOG 2>&1"
  local i
  for i in $(seq 50); do
    sleep 0.2
    if docker exec "$name" grep -q '^LayerFS page' $UI_LOG 2>/dev/null; then
      echo "LayerFS page of $project: http://localhost:$port"
      return
    fi
    [ -n "$(ui_pid "$name")" ] || [ "$i" -lt 3 ] || break
  done
  docker exec "$name" tail -n 20 $UI_LOG >&2 || true
  die "the LayerFS page of $project did not start"
}

cmd_ui_stop() {
  [ $# -eq 1 ] || usage
  check_project "$1"
  local name pid
  name=$(client "$1")
  pid=
  if [ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; then pid=$(ui_pid "$name"); fi
  if [ -z "$pid" ]; then echo "no LayerFS page of $1 running"; return; fi
  # SIGTERM, then SIGKILL after 5 s: the port is free when this returns
  docker exec "$name" sh -c "kill $pid; i=0; while kill -0 $pid 2>/dev/null && [ \$i -lt 25 ]; do sleep 0.2; i=\$((i+1)); done; kill -9 $pid 2>/dev/null; rm -f $UI_PID $UI_PORT"
  echo "LayerFS page of $1 stopped"
}

[ $# -ge 1 ] || usage
sub=$1; shift
case $sub in
  up) cmd_up "$@" ;;
  init) cmd_init "$@" ;;
  cli) cmd_cli "$@" ;;
  script) cmd_script "$@" ;;
  down) cmd_down "$@" ;;
  ui) cmd_ui "$@" ;;
  ui-stop) cmd_ui_stop "$@" ;;
esac
