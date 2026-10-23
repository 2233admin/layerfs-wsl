#!/bin/bash
# lfs-wsl.sh: layerfs-wsl, any agent harness's bridge to a LayerFS project in this
# WSL distro (DSH has its own integration; this is for the others).
#
# One long-lived SDK client container per project (lfsb-<project>), set up
# like /root/bench/lfs_run.sh: the LayerFS bundle and checkout at their own
# paths, the Docker socket, host networking and the project's Store volume.
# Every `cli`/`script` call is one `docker exec` in it with the DSH_LAYERFS_*
# environment DSH gives an agent's bash call, so lfs.js, SDK scripts and the
# SKILL.md examples work unchanged. The inner command's exit code and output
# are passed through.
#
# usage:
#   lfs-wsl.sh up     <project> <image>
#   lfs-wsl.sh init   <project> <image> <linux-src-dir>
#   lfs-wsl.sh cli    <project> <trace-id> -- <lfs.js args...>   (stdin passed through)
#   lfs-wsl.sh script <project> <trace-id> <script-path>          (under $LFSB_ROOT/scripts)
#   lfs-wsl.sh down   <project>
#   lfs-wsl.sh ui     <project> [port]      (the LayerFS page; its port is kept per project, see ui-ports)
#   lfs-wsl.sh ui-stop <project>
#   lfs-wsl.sh export <project> <dest-dir>  (main's files, minus /.gitignore paths)
#   lfs-wsl.sh rotate <project> <image> [new-project]
#   lfs-wsl.sh remove <project> <project>   (the name twice, to confirm)
#   lfs-wsl.sh projects                     (every project here, read-only)
#
# env: LFS_TRACE_STEP labels this call's SDK trace lines (DSH_LAYERFS_TRACE_STEP).
#
# LayerFS comes from two places, chosen by env. The core: LFSB_BUNDLE (layerfs-daemon,
# layerfs.node and a COMMIT file naming the commit they were built from) with
# LFSB_CHECKOUT (that commit's checkout: SDK JS, operator, lfs.js, SKILL.md); `up`
# refuses a bundle whose COMMIT is not the checkout's HEAD. The page: LFSB_UI_CHECKOUT,
# whose DSH host and view/model code ui/server.mjs loads (it runs on the core's SDK).
# A client is made for one core (the bundle's commit and these paths) and page checkout
# (LFSB_CORE in its environment); under other ones, `up` recreates it and the other
# subcommands refuse it.
set -euo pipefail

BUNDLE=${LFSB_BUNDLE:-/root/layerfs-next-bundle}
LAYERFS=${LFSB_CHECKOUT:-/root/layerfs-next}
UI_LAYERFS=${LFSB_UI_CHECKOUT:-/root/layerfs}
ROOT=${LFSB_ROOT:-/root/layerfs-wsl}
RUNTIME_IMAGE=${LFSB_RUNTIME_IMAGE:-layerfs-352-runtime:node24}
SDK=file://$LAYERFS/sdk/js/src/index.js
OPERATOR=file://$LAYERFS/sdk/js/operator/index.js
CLI=$LAYERFS/dsh/packages/host/src/lfs.js
SKILL=$LAYERFS/.agents/skills/layerfs-js-sdk/SKILL.md
CORE="$BUNDLE@$(tr -d ' \n' < "$BUNDLE/COMMIT" 2>/dev/null || echo -) $LAYERFS $UI_LAYERFS $ROOT"

die() { echo "lfs-wsl: $*" >&2; exit 64; }
usage() { sed -n '12,24p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }

valid_project() { [[ $1 =~ ^[a-z0-9]([a-z0-9_.-]{0,61}[a-z0-9])?$ ]]; }
check_project() {
  valid_project "$1" || die "bad project name '$1' (a-z 0-9 _ - ., 1-63 chars, letter/digit at both ends)"
}
# a trace id is <project>.<session>: the page and `remove` find a project's traces by that prefix
check_trace() {
  [[ $2 == "$1".* && ${2#"$1".} =~ ^[A-Za-z0-9_-]{1,128}$ ]] || die "bad trace id '$2': it must be $1.<session>, the session of letters, digits, '_' and '-'"
}
client() { echo "lfsb-$1"; }
image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || die "image '$1' not found in this distro's Docker"
}

# The core a client was made for: its LFSB_CORE (empty for a client without one,
# which is then taken as made for another core).
client_core() {
  local core
  core=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^LFSB_CORE=//p')
  echo "$core"
}

# The bundle must be built from the checkout's HEAD: its COMMIT file says from which.
# The old bundle has none; it is taken only with the checkout it was built from.
check_core() {
  local head built
  [ -x "$BUNDLE/layerfs-daemon" ] && [ -f "$BUNDLE/layerfs.node" ] || die "LFSB_BUNDLE $BUNDLE has no layerfs-daemon and layerfs.node"
  [ -f "${SDK#file://}" ] || die "LFSB_CHECKOUT $LAYERFS has no SDK (sdk/js/src/index.js)"
  [ -d "$UI_LAYERFS/dsh/packages/host/src" ] || die "LFSB_UI_CHECKOUT $UI_LAYERFS has no DSH host (dsh/packages/host/src)"
  head=$(git -C "$LAYERFS" rev-parse HEAD 2>/dev/null) || die "LFSB_CHECKOUT $LAYERFS is not a git checkout"
  if [ -f "$BUNDLE/COMMIT" ]; then
    built=$(tr -d ' \n' < "$BUNDLE/COMMIT")
    [ "$built" = "$head" ] || die "bundle $BUNDLE is built from $built, but checkout $LAYERFS is at $head; set LFSB_BUNDLE and LFSB_CHECKOUT to a matching pair"
  else
    [ "$LAYERFS" = /root/layerfs ] || die "bundle $BUNDLE has no COMMIT file; a bundle without one is taken only with LFSB_CHECKOUT=/root/layerfs"
  fi
}

# up <project> <image>: the project's client container, running. Idempotent;
# a client whose LAYERFS_IMAGE (or runtime image) resolves to another image id,
# or that was made for another core, page checkout or state folder, is recreated (the Store
# volume stays); a core change is refused while Sandboxes run.
cmd_up() {
  [ $# -eq 2 ] || usage
  local project=$1 image=$2 name sbx runtime have have_rt have_id have_core
  check_project "$project"
  check_core
  name=$(client "$project")
  sbx=$(image_id "$image")
  runtime=$(image_id "$RUNTIME_IMAGE")
  if have_rt=$(docker inspect --format '{{.Image}}' "$name" 2>/dev/null); then
    have=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^LAYERFS_IMAGE=//p')
    have_id=$(docker image inspect --format '{{.Id}}' "$have" 2>/dev/null || echo "${have:-none}")
    have_core=$(client_core "$name")
    if [ "$have_id $have_rt" = "$sbx $runtime" ] && [ "$have_core" = "$CORE" ]; then
      [ "$(docker inspect --format '{{.State.Running}}' "$name")" = true ] || docker start "$name" >/dev/null
      echo "client $name up (image $image, unchanged)"
      return
    fi
    [ "$have_core" = "$CORE" ] || refuse_busy "$project" "switching $name from core [$have_core] to [$CORE]"
    echo "client $name recreated: LAYERFS_IMAGE $have_id -> $sbx ($image), runtime $have_rt -> $runtime, core [$have_core] -> [$CORE]; Store volume $name-store kept"
    docker rm -f "$name" >/dev/null
  fi
  mkdir -p "$ROOT/scripts" "$ROOT/traces"
  docker volume inspect "$name-store" >/dev/null 2>&1 || docker volume create "$name-store" >/dev/null
  local mounts=(--mount type=bind,src="$BUNDLE",dst="$BUNDLE",readonly
    --mount type=bind,src="$LAYERFS",dst="$LAYERFS",readonly)
  [ "$UI_LAYERFS" = "$LAYERFS" ] || mounts+=(--mount type=bind,src="$UI_LAYERFS",dst="$UI_LAYERFS",readonly)
  docker run -d --name "$name" --pull never --init \
    --label lfsb.project="$project" \
    "${mounts[@]}" \
    --mount type=bind,src="$ROOT",dst="$ROOT" \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount type=volume,src="$name-store",dst=/layerfs-store,volume-nocopy \
    -e LAYERFS_HOME=/layerfs-store/sdk-home -e LAYERFS_STORE_PATH=/layerfs-store/global/store.sqlite \
    -e LAYERFS_DOCKER=/var/run/docker.sock -e LAYERFS_IMAGE="$sbx" -e LAYERFS_VOLUME="$name-store" \
    -e LAYERFS_DAEMON="$BUNDLE/layerfs-daemon" -e LAYERFS_NATIVE="$BUNDLE/layerfs.node" \
    -e LAYERFS_CONTAINER_PREFIX="$name-" -e LAYERFS_CONSTRUCTION_WORKERS=1 \
    -e LAYERFS_DAEMON_HOST=127.0.0.1 \
    -e LFSB_CORE="$CORE" -e LFSB_CHECKOUT="$LAYERFS" -e LFSB_UI_CHECKOUT="$UI_LAYERFS" -e LFSB_ROOT="$ROOT" \
    --network host -w "$BUNDLE" --entrypoint /bin/sh "$runtime" \
    -c 'umask 077; mkdir -p /layerfs-store/sdk-home /layerfs-store/global; exec sleep infinity' >/dev/null
  echo "client $name up (image $image, Store volume $name-store, core $(cat "$BUNDLE/COMMIT" 2>/dev/null || echo "$BUNDLE"))"
}

# The running client of <project>, started again when stopped; refused when it was
# made for another core, page checkout or state folder than this bridge's (`up` switches it).
running_client() {
  local name have
  name=$(client "$1")
  case $(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo missing) in
    true) ;;
    false) docker start "$name" >/dev/null ;;
    *) die "project '$1' has no client container; run: lfs-wsl.sh init $1 <image> <src-dir> (or up)" ;;
  esac
  have=$(client_core "$name")
  [ "$have" = "$CORE" ] || die "client $name was made for [$have] (bundle, checkout, page checkout, state folder), this bridge uses [$CORE]: run lfs-wsl.sh up $1 <image> to recreate it (refused while its Sandboxes run: unmount their Workspaces first), or set LFSB_BUNDLE, LFSB_CHECKOUT, LFSB_UI_CHECKOUT and LFSB_ROOT to the client's"
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
  tmp=/tmp/lfsb-init-$project
  docker exec "$name" rm -rf "$tmp"
  docker cp -q "$src/." "$name:$tmp"
  # LayerFS commits build output (target/, node_modules/) with the sources; without a
  # /.lww rule, two Branches that both built conflict on those files at merge. The
  # upstream default is to merge every .gitignore path newer-wins.
  docker exec "$name" sh -c '[ -e "$1/.lww" ] || printf "%%include .gitignore\n" >"$1/.lww"' sh "$tmp"
  docker exec "$name" sh -c '[ -e "$1/.gitignore" ]' sh "$tmp" \
    || echo "lfs-wsl: $src has no .gitignore; /.lww includes nothing until one is added" >&2
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
  check_project "$project"; check_trace "$project" "$trace"
  exec_agent "$project" "$trace" node "$CLI" "$@"
}

cmd_script() {
  [ $# -eq 3 ] || usage
  local project=$1 trace=$2 path
  check_project "$project"; check_trace "$project" "$trace"
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

project_exists() { docker inspect "$(client "$1")" >/dev/null 2>&1 || docker volume inspect "$(client "$1")-store" >/dev/null 2>&1; }

# Containers other than the client that use the project's Store volume (its
# Sandboxes, and what failed starts left), one "<name> <state>" per line.
volume_users() {
  local name
  name=$(client "$1")
  docker ps -a --filter "volume=$name-store" --format '{{.Names}} {{.State}}' | awk -v c="$name" '$1 != c'
}

# Names of the project's containers that still run something (DSH's remove.js:
# any state but created, exited or dead).
busy_sandboxes() {
  volume_users "$1" | awk '$2 != "created" && $2 != "exited" && $2 != "dead" { print $1 }'
}

refuse_busy() {
  local busy
  busy=$(busy_sandboxes "$1")
  [ -z "$busy" ] || die "$2 refused: running Sandboxes still use $(client "$1")-store: $(echo $busy). A Sandbox closes 2 minutes after its last Workspace is unmounted; unmount the Workspaces (or wait) and run it again"
}

# export <project> <dest-dir>: main's files (regular files, folders, symlinks and
# their modes; owners are not kept) into a new or empty distro folder, without
# the paths main's root /.gitignore ignores. main cannot be mounted, so a throwaway
# Branch lfsb-export-<time> forked from it is (forking copies nothing; the Branch
# stays in the project, which has no Branch removal). In its Workspace, tar writes
# the tree to stdout, which workspace.exec streams raw to this process's tar. The
# Sandbox image needs tar, and git when main has a /.gitignore.
cmd_export() {
  [ $# -eq 2 ] || usage
  local project=$1 dest=$2 name created=0 rc=0 cmd js
  check_project "$project"
  [[ $dest == /* ]] || die "destination '$dest' must be an absolute distro path"
  if [ -e "$dest" ]; then
    [ -d "$dest" ] && [ -z "$(ls -A "$dest")" ] || die "destination '$dest' is not an empty folder"
  else
    mkdir -p "$dest"
    created=1
  fi
  name=$(running_client "$project")
  # Run by bash -c at the Workspace root. git lists the ignored paths, ignored
  # folders as one entry ("target/"); git never lists a .git folder, so it is kept.
  IFS= read -r -d '' cmd <<'EOF' || true
set -euo pipefail
command -v tar >/dev/null || { echo "export: the Sandbox image has no tar" >&2; exit 3; }
x=$(mktemp)
if [ -f .gitignore ]; then
  command -v git >/dev/null || { echo "export: the Sandbox image has no git, needed to read /.gitignore" >&2; exit 3; }
  g=$(mktemp -d)
  git -c safe.directory='*' --git-dir="$g" init -q
  git -c safe.directory='*' --git-dir="$g" --work-tree=. ls-files -z --others --ignored --directory --exclude-from=.gitignore >"$x.z"
  while IFS= read -r -d '' p; do
    case $p in *$'\n'*) echo "export: an ignored path has a newline in its name: $p" >&2; exit 3 ;; esac
    printf './%s\n' "${p%/}"
  done <"$x.z" >"$x"
fi
tar --anchored --no-wildcards --exclude-from="$x" -cf - .
EOF
  IFS= read -r -d '' js <<'EOF' || true
const { LayerFS } = await import(process.env.SDK);
const lf = new LayerFS(process.env.P);
let ws;
try {
  await lf.branch.fork(process.env.BRANCH, "main");
  ws = await lf.workspace.mount(process.env.BRANCH);
  const r = await lf.workspace.exec(ws, process.env.CMD, "layerfs-wsl export", { stdout: process.stdout, stderr: process.stderr });
  if (r.exitCode !== 0) { console.error(`export: the Workspace command exited ${r.exitCode}`); process.exitCode = 2; }
} catch (e) {
  console.error(`${e.code ?? "Error"}: ${e.message}`);
  process.exitCode = 2;
} finally {
  if (ws) await lf.workspace.unmount(ws, true).catch((e) => console.error(`export: could not unmount ${ws.path}: ${e.message}`));
  await lf.close();
}
EOF
  docker exec -w "$BUNDLE" -e P="$project" -e SDK="$SDK" -e BRANCH="lfsb-export-$(date -u +%Y%m%d-%H%M%S)-$$" -e CMD="$cmd" \
    "$name" node --input-type=module -e "$js" | tar -xpf - --no-same-owner -C "$dest" || rc=$?
  if [ $rc -ne 0 ]; then
    if [ $created = 1 ]; then rm -rf "$dest"; else find "$dest" -mindepth 1 -delete; fi
    die "export of $project failed (exit $rc); $dest left as it was"
  fi
  echo "exported main of $project to $dest: $(find "$dest" -mindepth 1 | wc -l) entries, $(du -sh "$dest" | cut -f1)"
}

# remove <project> <project>: the project's stopped Sandboxes, client container and
# Store volume, and its trace files; refused while a Sandbox runs (DSH's remove.js).
cmd_remove() {
  [ $# -eq 2 ] || usage
  local project=$1 name f rest stopped n=0
  check_project "$project"
  [ "$2" = "$project" ] || die "remove refused: the confirmation '$2' is not the project name; to remove it, run: lfs-wsl.sh remove $project $project"
  name=$(client "$project")
  project_exists "$project" || die "no LayerFS project $project here (no container $name, no volume $name-store)"
  refuse_busy "$project" remove
  stopped=$(volume_users "$project" | awk '{ print $1 }')
  [ -z "$stopped" ] || docker rm $stopped >/dev/null
  docker rm -f "$name" >/dev/null 2>&1 || true
  ! docker volume inspect "$name-store" >/dev/null 2>&1 || docker volume rm "$name-store" >/dev/null
  # trace ids are <project>.<session>, the session part without dots
  for f in "$ROOT/traces/$project".*; do
    rest=${f##*/}
    rest=${rest#"$project".}
    case $rest in *.meta.json) rest=${rest%.meta.json} ;; *.jsonl) rest=${rest%.jsonl} ;; *) continue ;; esac
    [[ -n $rest && $rest != *.* ]] || continue
    rm -f "$f"
    n=$((n + 1))
  done
  ports_lock
  registry_drop "$project"
  echo "removed LayerFS project $project: client $name, Store volume $name-store${stopped:+, stopped Sandboxes $(echo $stopped)}, $n trace files"
}

# The size of a project's Store volume, as du -sh gives it.
store_size() {
  local out
  out=$(docker exec "$(client "$1")" du -sh /layerfs-store)
  echo "${out%%$'\t'*}"
}

# rotate <project> <image> [new-project]: a new project seeded from main's files (the
# export), with no Branches and no history; the old project is kept for `remove`.
# The default name is <project>-r<N> (a trailing -r<N> of <project> replaced), with
# the first N whose container and Store volume are free.
cmd_rotate() {
  [ $# -ge 2 ] && [ $# -le 3 ] || usage
  local project=$1 image=$2 new=${3:-} name stem n dest before after js
  check_project "$project"
  image_id "$image" >/dev/null
  name=$(client "$project")
  if [ -z "$new" ]; then
    stem=$project
    if [[ $project =~ ^(.+)-r[0-9]+$ ]]; then stem=${BASH_REMATCH[1]}; fi
    n=1
    while project_exists "$stem-r$n"; do n=$((n + 1)); done
    new=$stem-r$n
  fi
  check_project "$new"
  [ "$new" != "$project" ] || die "the new project must have another name than $project"
  ! project_exists "$new" || die "project $new already exists here (container or Store volume $(client "$new")-store); pick another name"
  running_client "$project" >/dev/null
  refuse_busy "$project" rotate
  echo "rotating LayerFS project $project -> $new"
  # Branches whose head no main Layer's source Commit reaches (by parents and merge
  # parents) are dropped work. The commit graph is every Branch's first-parent line.
  IFS= read -r -d '' js <<'EOF' || true
const { LayerFS } = await import(process.env.SDK);
const { LayerFSOperator } = await import(process.env.OPERATOR);
const lf = new LayerFS(process.env.P);
try {
  const branches = [];
  for (let pos = 0; ; ) {
    const p = await lf.project.list_branches(1000, pos);
    branches.push(...p.items.filter((b) => b.name !== "main"));
    if (!p.hasMore) break;
    pos = p.nextPagePos ?? pos + p.items.length;
  }
  const commits = new Map();
  for (const b of branches) {
    if (!b.head || commits.has(b.head)) continue;
    load: for (let pos = 0; ; ) {
      const p = await lf.branch.list_commits(b.name, 200, pos);
      for (const c of p.items) {
        if (commits.has(c.id)) break load; // its first-parent line is loaded already
        commits.set(c.id, c);
      }
      if (!p.hasMore) break;
      pos = p.nextPagePos ?? pos + p.items.length;
    }
  }
  const history = await new LayerFSOperator(lf).inspect.snapshot();
  const onMain = new Set();
  const next = history.layers.map((l) => l.sourceCommit).filter(Boolean);
  while (next.length) {
    const id = next.pop();
    if (onMain.has(id)) continue;
    onMain.add(id);
    const c = commits.get(id);
    if (c) next.push(...[c.parent, c.secondParent].filter(Boolean));
  }
  const dropped = branches.filter((b) => b.head && !onMain.has(b.head)).map((b) => b.name);
  const rest = branches.filter((b) => !dropped.includes(b.name)).map((b) => b.name);
  console.log(`dropped (head not on main's history): ${dropped.join(", ") || "none"}`);
  if (rest.length) console.log(`also not carried over (on main's history or without Commits): ${rest.join(", ")}`);
  if (history.moreLayers) console.log(`note: only main's newest ${history.layers.length} Layers were read; a Branch published only before them is listed as dropped too`);
} finally {
  await lf.close();
}
EOF
  docker exec -w "$BUNDLE" -e P="$project" -e SDK="$SDK" -e OPERATOR="$OPERATOR" "$name" node --input-type=module -e "$js"
  mkdir -p "$ROOT/exports"
  dest=$ROOT/exports/$project-$(date -u +%Y%m%dT%H%M%SZ)
  cmd_export "$project" "$dest"
  before=$(store_size "$project")
  cmd_init "$new" "$image" "$dest" || die "init of $new from $dest failed; $project is unchanged and the export is kept"
  after=$(store_size "$new")
  echo "rotated: $project -> $new"
  echo "  old: $project, Store volume $name-store, $before (kept; remove it with: lfs-wsl.sh remove $project $project)"
  echo "  new: $new, Store volume $(client "$new")-store, $after"
  echo "  export: $dest (a full copy of main's files; delete it yourself)"
  echo "new project: $new"
}

# The page's server (ui/server.mjs, installed under $ROOT/ui) runs detached in
# the client; its pid, port and log are in the client's /tmp.
UI_PID=/tmp/lfsb-ui.pid UI_PORT=/tmp/lfsb-ui.port UI_LOG=/tmp/lfsb-ui.log
# The pid of the client's running page server, if any. The pid file outlives a container
# restart, after which its pid can be this very check (whose command line names
# server.mjs too), so the process must also be node.
ui_pid() {
  docker exec "$1" sh -c "p=\$(cat $UI_PID 2>/dev/null) && case \$(readlink /proc/\$p/exe) in */node) ;; *) exit 0 ;; esac && grep -q server.mjs /proc/\$p/cmdline 2>/dev/null && echo \$p" || true
}

# ui-ports: one "<project> <port>" line per project whose page was started, kept
# across stops and restarts so a project's page keeps its URL. The page's project
# switcher reads it (server.mjs /bridge/projects). Changed under the lock only.
UI_PORTS=$ROOT/ui-ports
UI_FIRST_PORT=${LFSB_UI_PORT:-8787}
ports_lock() { exec 9>"$UI_PORTS.lock"; flock 9; }
registry_port() { [ -f "$UI_PORTS" ] && awk -v p="$1" '$1 == p { print $2; exit }' "$UI_PORTS" || true; }
registry_owner() { [ -f "$UI_PORTS" ] && awk -v n="$1" '$2 == n { print $1; exit }' "$UI_PORTS" || true; }
# registry_set <project> <port>: the project's one line, and nobody else's on that port.
registry_set() {
  local tmp=$UI_PORTS.tmp
  { [ -f "$UI_PORTS" ] && awk -v p="$1" -v n="$2" '$1 != p && $2 != n' "$UI_PORTS"; echo "$1 $2"; } > "$tmp"
  mv "$tmp" "$UI_PORTS"
}
registry_drop() {
  [ -f "$UI_PORTS" ] || return 0
  awk -v p="$1" '$1 != p' "$UI_PORTS" > "$UI_PORTS.tmp" && mv "$UI_PORTS.tmp" "$UI_PORTS"
}
port_listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# The project whose page answers on <port> (server.mjs /bridge/whoami), if any.
page_project() { curl -fsS -m 1 "http://127.0.0.1:$1/bridge/whoami" 2>/dev/null | sed -n 's/.*"project":"\([^"]*\)".*/\1/p' || true; }
# The first port from <from> on that no other project claims and nothing listens on.
free_port() {
  local p owner
  for ((p = $1; p <= 65535 && p < $1 + 500; p++)); do
    owner=$(registry_owner "$p")
    [ -z "$owner" ] || [ "$owner" = "$2" ] || continue
    port_listening "$p" || { echo "$p"; return; }
  done
  die "no free port from $1 on"
}

# ui <project> [port]: the project's LayerFS page, started when it is not
# running on that port (one page per client; another port restarts it). Without a
# port, the project keeps the port it had; a new project gets the first free one
# from $UI_FIRST_PORT, and a kept port some other program took is replaced.
cmd_ui() {
  [ $# -ge 1 ] && [ $# -le 2 ] || usage
  local project=$1 want=${2:-} port name pid cur owner
  check_project "$project"
  [ -z "$want" ] || { [[ $want =~ ^[0-9]{1,5}$ ]] && [ "$want" -ge 1 ] && [ "$want" -le 65535 ]; } || die "bad port '$want'"
  [ -f "$ROOT/ui/server.mjs" ] || die "$ROOT/ui/server.mjs is not installed (see README: Install)"
  name=$(running_client "$project")
  ports_lock
  pid=$(ui_pid "$name")
  cur=
  [ -z "$pid" ] || cur=$(docker exec "$name" cat $UI_PORT 2>/dev/null || true)
  if [ -n "$want" ]; then
    port=$want
    owner=$(registry_owner "$port")
    if [ -n "$owner" ] && [ "$owner" != "$project" ] && [ "$(page_project "$port")" = "$owner" ]; then
      die "port $port serves the page of $owner; pick another port, or stop it: lfs-wsl.sh ui-stop $owner"
    fi
  else
    port=$(registry_port "$project")
    # a page started before ui-ports existed keeps its port
    [ -n "$port" ] || [ -z "$cur" ] || [ -n "$(registry_owner "$cur")" ] || port=$cur
    [ -n "$port" ] || port=$(free_port "$UI_FIRST_PORT" "$project")
  fi
  if [ -n "$pid" ] && [ "$cur" = "$port" ]; then
    registry_set "$project" "$port"
    echo "LayerFS page of $project already running: http://localhost:$port"
    return
  fi
  [ -z "$pid" ] || cmd_ui_stop "$project" >/dev/null
  if port_listening "$port"; then
    [ -z "$want" ] || die "port $port is in use by another program"
    owner=$port
    port=$(free_port "$((port + 1))" "$project")
    echo "port $owner of $project's page is taken by another program; moved to $port"
  fi
  registry_set "$project" "$port"
  docker exec -d -w "$BUNDLE" "$name" sh -c "echo \$\$ > $UI_PID; echo $port > $UI_PORT; exec node $ROOT/ui/server.mjs $project $port > $UI_LOG 2>&1"
  # ready when the page answers as this project's (the log may still hold an old run's line)
  local i
  for i in $(seq 50); do
    sleep 0.2
    if [ "$(page_project "$port")" = "$project" ]; then
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

# The size of a volume as du -sh gives it, read at its mountpoint (dockerd runs in
# this distro): no container is started or exec'd. du reads every file, so a big
# Store takes a while.
volume_size() {
  local dir out
  dir=$(docker volume inspect --format '{{.Mountpoint}}' "$1" 2>/dev/null) || return 1
  out=$(du -sh "$dir") || return 1
  echo "${out%%$'\t'*}"
}

# An image id as the image's first tag, else as a short id.
image_name() {
  local tag id=${1#sha256:}
  tag=$(docker image inspect --format '{{if .RepoTags}}{{index .RepoTags 0}}{{end}}' "$1" 2>/dev/null || true)
  echo "${tag:-${id:0:12}}"
}

# projects: every project here, read-only. The Docker Engine and the free disk under
# its data root; one row per project found from lfsb-<project>-store volumes and
# lfsb-<project> clients (label lfsb.project); then leftovers: Sandboxes whose
# Store volume is gone, and clients without a Store volume.
cmd_projects() {
  [ $# -eq 0 ] || usage
  local root p name vol state img size up down rows= leftovers= c line page
  root=$(docker info --format '{{.DockerRootDir}}')
  echo "docker engine $(docker version --format '{{.Server.Version}}'), $root: $(df -hP "$root" | awk 'NR == 2 { print $4 " free of " $2 }')"
  for p in $( { docker volume ls --format '{{.Name}}' | sed -n 's/^lfsb-\(.*\)-store$/\1/p'
                docker ps -a --filter label=lfsb.project --format '{{.Label "lfsb.project"}}'; } | sort -u); do
    valid_project "$p" || continue
    name=$(client "$p") vol=$(client "$p")-store
    case $(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || echo missing) in
      true) state=running ;;
      false) state=stopped ;;
      *) state=missing ;;
    esac
    img=-
    [ "$state" = missing ] || img=$(image_name "$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^LAYERFS_IMAGE=//p')")
    if ! size=$(volume_size "$vol"); then
      size=none
      [ "$state" = missing ] || leftovers+="  client $name ($state): no Store volume $vol"$'\n'
    fi
    # as busy_sandboxes: created, exited and dead are stopped, any other state runs
    read -r up down < <(volume_users "$p" | awk '{ if ($2 == "created" || $2 == "exited" || $2 == "dead") d++; else u++ } END { print u + 0, d + 0 }')
    page=$(registry_port "$p")
    if [ -n "$page" ]; then [ "$(page_project "$page")" = "$p" ] && page="http://localhost:$page" || page=":$page (stopped)"; else page=-; fi
    rows+=$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$p" "$state" "$img" "$size" "$up running, $down stopped" "$page")$'\n'
  done
  if [ -n "$rows" ]; then
    { printf 'PROJECT\tCLIENT\tSANDBOX IMAGE\tSTORE\tSANDBOXES\tPAGE\n'; printf '%s' "$rows"; } | awk -F '\t' '
      { for (i = 1; i <= NF; i++) { cell[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) } n = NF }
      END { for (r = 1; r <= NR; r++) { s = "  "; for (i = 1; i < n; i++) s = s sprintf("%-" w[i] "s  ", cell[r, i]); print s cell[r, n] } }'
  else
    echo "no LayerFS projects (no lfsb-<project>-store volume, no lfsb-<project> client)"
  fi
  for c in $(docker ps -aq --filter label=layerfs.role=sandbox); do
    line=$(docker inspect --format '{{.Name}} {{.State.Status}}{{range .Mounts}}{{if eq .Destination "/layerfs-store"}} {{.Name}}{{end}}{{end}}' "$c")
    read -r name state vol <<<"$line"
    [ -n "${vol:-}" ] && ! docker volume inspect "$vol" >/dev/null 2>&1 || continue
    leftovers+="  sandbox ${name#/} ($state): Store volume $vol is gone"$'\n'
  done
  if [ -n "$leftovers" ]; then
    echo "leftovers:"
    printf '%s' "$leftovers"
  else
    echo "leftovers: none"
  fi
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
  export) cmd_export "$@" ;;
  rotate) cmd_rotate "$@" ;;
  remove) cmd_remove "$@" ;;
  projects) cmd_projects "$@" ;;
esac
