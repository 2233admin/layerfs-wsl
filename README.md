# layerfs-bridge

LayerFS for coding agents other than DSH. DSH has its own LayerFS integration
(`dsh-layerfs`); layerfs-bridge gives the same thing to any agent harness that can run a
command: agents fork Branches, run commands in Workspaces, commit, merge and publish through
the LayerFS JS SDK, which runs in a WSL distro on Windows.

- `bridge/lfs-bridge.sh`: the bridge, a plain command in the distro
  (`lfs-bridge.sh <subcommand>`). One long-lived SDK client container per project
  (`lfsb-<project>`, Store volume `lfsb-<project>-store`). Each call is one `docker exec` with
  the `DSH_LAYERFS_*` environment a DSH agent's bash call gets, so DSH's `lfs.js` and SDK
  scripts run unchanged. SDK traces go to
  `/root/layerfs-bridge/traces/<project>.<session>.jsonl`, one file per agent session and
  project. The SDK's trace lines do not name the project, so the file name does. `cli` and
  `script` take that trace id `<project>.<session>` (the session of letters, digits, `_` and
  `-`; any other is refused): the page and `remove` find a project's traces by that prefix.
- `ui/`: the LayerFS page (DSH's Work/History/Sandboxes view) of one project, served from its
  client container; see [The LayerFS page](#the-layerfs-page).
- `install/`: the installer (a WSL distro with Docker, LayerFS and the bridge).
- Adapters, one per harness:
  - `extension/index.ts`, for OMP: tools `layerfs` (an `lfs.js` command) and
    `layerfs_script` (a Node ES module run against the SDK), the command `/layerfs`, the
    project line in each agent's context and per-call records in each session.
  - [docs/other-harnesses.md](docs/other-harnesses.md): the instruction file Claude Code
    worked with end to end, calling the bridge through `wsl.exe` itself.

Two LayerFS versions are in use, each pinned:

- **Core and SDK: `e49d1613f`**, upstream `2e5061798` plus the merge fix of upstream
  [PR #409](https://github.com/Ephemeral-AI-Lab/layerfs/pull/409) (branch
  `fix/merge-binding-kind` of `2233admin/layerfs`). The daemon and native addon come from the
  bundle `/root/layerfs-next-bundle`, the SDK, operator, `lfs.js` CLI and SDK guide from the
  checkout `/root/layerfs-next`. Once #409 is merged upstream, move both to an upstream commit.
- **The page's DSH code: `5fb68dd`** (`/root/layerfs`). The page runs DSH's host modules
  (`route.js`, `Collector`, `TreeReader`) and view/model code unbuilt from that checkout, so
  it stays on the commit it was written against; it draws what the newer core writes.

## Install

Needs x86_64 Windows with WSL 2. From a clone of this repository, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

`install\install.ps1`:

1. creates the WSL distro `layerfs-lab` (`-Distro`, `-Location` choose another name and
   folder; default `%USERPROFILE%\wsl\<distro>`) from `-Base archlinux` (default) or
   `-Base Ubuntu-24.04`, with systemd on; an existing distro (Arch, or Ubuntu 22.04 or later)
   is used as it is;
2. runs `install/distro-setup.sh` in it as root: Docker (the distro's own dockerd, on its own
   container network, below), LayerFS cloned to `/root/layerfs-upstream` with the two pinned
   worktrees, the core bundle from this repository's release
   [`core-e49d1613f`](https://github.com/2233admin/layerfs-bridge/releases/tag/core-e49d1613f)
   (sha256-checked; `-FromSource` builds it instead with `bridge/build-bundle.sh`, a release
   cargo build of tens of minutes), the client image, both Sandbox images, the bridge, the
   page and the `hello` fixture;
3. registers the logon task `layerfs-bridge keepalive <distro>` (`install/keepalive.ps1`): WSL
   stops a distro a few seconds after the last `wsl.exe` using it exits, which also stops its
   dockerd, the clients, their pages and every mounted Workspace; the task holds one hidden
   `wsl.exe` open while you are logged on (`keepalive.ps1 -Distro <d> -Remove` removes it);
4. links this checkout as the OMP plugin (`-NoPlugin` skips that; other harnesses need nothing
   on the Windows side).

Finished steps are skipped, so running it again resumes or repairs an install. It ends with the
`/layerfs init` line to run in OMP; for a distro other than `layerfs-lab`, that line names it as
its last argument. Every bridge call runs as root (`wsl -u root`): Ubuntu has a default user.

**Its own container network.** All WSL 2 distros share one network namespace. A dockerd on the
default `docker0` would join another distro's `docker0` (two daemons handing out the same
addresses on one bridge), and two dockerds managing iptables fight over the same chains. So the
distro's dockerd runs with `{"bridge": "lfs-<id>", "iptables": false}` in
`/etc/docker/daemon.json`, and `install/lfs-net.sh` (run by `lfsb-net.service` before Docker)
provides the bridge, forwarding and NAT. `<id>` is random per install and seeds a
`10.64-127.x.0/24` subnet; both are kept in `/etc/layerfs-bridge/net.env`, so they stay this
distro's while it is down, and the bridge carries the id as its alias: a bridge of that name
owned by another distro is refused, never shared. Published Sandbox ports go through
Docker's userland proxy on `127.0.0.1` (random ports). `distro-setup.sh` refuses a distro whose
`/etc/docker/daemon.json` it did not write, and leaves an older install that already runs on
`docker0` as it is.

**From omp-layerfs (this project's old name).** On a distro installed before the rename,
`distro-setup.sh` runs `install/migrate-from-omp-layerfs.sh`: per project it reclaims the idle
Sandboxes through the SDK (their records name the old container and volume), refuses while
one runs, removes the old client, copies `omp-lfs-<p>-store` to `lfsb-<p>-store` and checks
the copy; then it moves `/root/omp-layerfs`, retags the `omp-lfs-*` images as `lfsb-*`, and
starts each client and page again. The old volumes stay until you `docker volume rm` them.
Folder bindings (`.omp/layerfs.json`) naming an `omp-lfs-*` image need the new name for
`/layerfs rotate`.

Tested from fresh clones on one machine, with `layerfs-lab`'s dockerd (on `docker0`) running
throughout:

- **Fresh Ubuntu 24.04 and fresh Arch.** `install.ps1` (`-NoPlugin`) then `/layerfs init … <distro>`, and an OMP
  agent forked, added the crate `itoa` (downloaded from crates.io in the Sandbox), ran
  `cargo test` (3 passed) and committed. The page answered.
- **Coexistence.** Three dockerds ran at once. Restarting `layerfs-lab`'s dockerd left the
  others' Sandboxes with egress, and `layerfs-lab`'s Sandbox kept egress too.
- **Reboot.** After `wsl --terminate`, `lfsb-net.service` brought the bridge back before
  Docker.
- **Owner guard.** A bridge with the stopped distro's name created by another distro with
  another owner made `lfs-net.sh up` refuse it and Docker stay down; with it removed, both
  came back.
- **Migration.** An install of the last omp-layerfs commit with a project, a Workspace and a
  page, upgraded by this installer: the first run stopped with "Sandboxes still run"; the
  run after the Sandbox closed itself copied the Store, carried the network over, retagged the
  images, and the project's next Workspace (after a reboot) ran on `lfsb-hello-hello-1` with
  egress.

What the bridge expects in the distro (`distro-setup.sh` provides all of it): Docker, the client
image `layerfs-352-runtime:node24` (built from the core checkout's
`dsh/tools/history/runtime`), a sandbox image per project kind, and three LayerFS paths:

| Variable | Default | Holds |
|---|---|---|
| `LFSB_BUNDLE` | `/root/layerfs-next-bundle` | `layerfs-daemon`, `layerfs.node`, and a `COMMIT` file with the commit they were built from |
| `LFSB_CHECKOUT` | `/root/layerfs-next` | the LayerFS checkout at that commit: SDK, operator, `lfs.js`, SDK guide |
| `LFSB_UI_CHECKOUT` | `/root/layerfs` | the checkout (5fb68dd) whose DSH host and view code the page runs |

`up` and `init` refuse a bundle whose `COMMIT` is not the checkout's `HEAD` (a bundle
without `COMMIT` is taken only with `LFSB_CHECKOUT=/root/layerfs`). Each client records
these three paths and the state folder `LFSB_ROOT` (default `/root/layerfs-bridge`) as
`LFSB_CORE`; `up` recreates a client made for others (refused while its Sandboxes run), and
`cli`, `script`, `export`, `ui` and `rotate` refuse such a client until `up` has run.
`LFSB_RUNTIME_IMAGE` overrides the client image.

`bridge/build-bundle.sh <rev>` builds the bundle: a release build in `rust:1.85.1-bookworm`
(the addon then needs glibc 2.34 at most, which the client image has) from a worktree of
`/root/layerfs-upstream` at `<rev>`, with `COMMIT` written beside the binaries (`JOBS` caps
cargo's jobs, default 8).

Sandbox images: `bridge/rust-sandbox.Dockerfile` (`lfsb-rust-sandbox:2`, incremental
Cargo builds; the recipe explains why it must match the host's toolchain) and
`bridge/node-sandbox.Dockerfile` (`lfsb-node-sandbox:3`, pnpm projects).

Rollback to the 5fb68dd core (only on an install that still has the old bundle
`/root/layerfs-linux-build`; `install.ps1` does not make one) is an environment change while
the project is idle: `LFSB_BUNDLE=/root/layerfs-linux-build LFSB_CHECKOUT=/root/layerfs
lfs-bridge.sh up <p> lfsb-rust-sandbox:1` (the Rust image without incremental builds, see
below), then `ui <p>`. For OMP, set the same two variables on Windows and list them in `WSLENV`
(`LFSB_BUNDLE/u:LFSB_CHECKOUT/u`); this OMP route has not been run yet. Stores written
by either core open on the other (tested both ways on copies of real Stores).

After changing `bridge/` or `ui/` in this checkout, install them again (from this folder):

```powershell
wsl -d layerfs-lab -u root -- bash -c "tr -d '\r' < bridge/lfs-bridge.sh > /opt/layerfs-bridge/lfs-bridge.sh && chmod 755 /opt/layerfs-bridge/lfs-bridge.sh"
wsl -d layerfs-lab -u root -- bash -c "cp ui/server.mjs ui/page.js ui/index.html /root/layerfs-bridge/ui/"
```

The plugin: the repository root is the plugin package (`package.json`,
`"omp": { "extensions": ["./extension/index.ts"] }`); `omp plugin link <this folder>` (done by
`install.ps1`) junctions it into `~/.omp/plugins/node_modules/layerfs-bridge`, so edits to this
checkout take effect in the next session. `omp plugin list` shows `layerfs-bridge@0.1.0`; `omp
plugin disable layerfs-bridge` / `omp plugin enable layerfs-bridge` turn it off and on. Every OMP
session loads it, and any folder with `.omp/layerfs.json` works without `-e`, e.g. from `e2e/`:
`omp -p "/layerfs status" < NUL` prints `hello`'s Branches (in `--mode json` the text arrives
as a `layerfs` custom message).

## Use

Bind a folder to a project (copies a distro folder into a new LayerFS Store once):

```text
/layerfs init hello lfsb-rust-sandbox:2 /root/layerfs-bridge/fixtures/hello [distro]
```

This writes `.omp/layerfs.json` (`{ "distro", "project", "image" }`) in the folder;
without it the tools refuse. The distro is the one named, else the folder's previous
binding's, else `layerfs-lab`; every later call follows the binding. `/layerfs status` lists
Branches, `/layerfs down` stops the
client container (the Store volume stays). `/layerfs projects` lists every project in the
distro ([All projects](#all-projects)). `/layerfs export`, `/layerfs rotate` and
`/layerfs remove` are in [Rotating a project's Store](#rotating-a-projects-store).

Build output is committed with the sources (that is what makes a new Workspace start with
a warm `target/`). So that two Branches that both built can still merge, `init` writes a
root `/.lww` of `%include .gitignore` when the source has none: `.gitignore` paths merge
newer-wins instead of conflicting. They are still stored; the Store never deletes history
(see [Rotating a project's Store](#rotating-a-projects-store)).
Rust: the 5fb68dd core cannot merge two Branches whose `target/` holds Cargo incremental
dirs (`target/*/incremental`; `Failed: invalid record: binding kind`). `e49d1613f` merges
them; on 5fb68dd use `lfsb-rust-sandbox:1`, built with `CARGO_INCREMENTAL=0`.
After a merge of two Branches that both built, rebuild before trusting a test run:
`/target` keeps the newer side's build, whose fingerprints are newer than the other side's
merged sources (a merge keeps each file's mtime), so Cargo can call the merged crate fresh
and run one side's old test binary. Seen on `hello`: 7 tests instead of 8 until
`cargo clean -p hello && cargo test`. The same holds for any build tool that compares
mtimes.
pnpm: a Workspace mounts at a new `/workspaces/<N>` each time, and pnpm 11's workspace state
records the absolute path it installed at, so its pre-run check would reinstall the
committed `node_modules` in every fork. `lfsb-node-sandbox:3` sets
`pnpm_config_verify_deps_before_run=false` (pnpm 11 ignores `npm_config_*` for settings).
With that check off, pnpm no longer notices stale dependencies: a Branch that changes a
`package.json`, `pnpm-lock.yaml` or the workspace's packages must run `pnpm install` in a
Workspace (and commit it) before `pnpm run`.

Agents then call, for example:

- `layerfs {"args": ["fork", "feat"]}`, `layerfs {"args": ["run", "feat", "cargo test"]}`,
  `layerfs {"args": ["write", "feat", "/notes.txt"], "stdin": "..."}`. Commands:
  `status | log | ls | cat | grep | diff | fork | write | run`.
- `layerfs_script {"source": "const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK); ..."}`
  for merge, publish and multi-step Workspace work. `main` is read-only: fork, work,
  commit, `branch.merge`, `branch.publish`. The SDK guide is at
  `\\wsl.localhost\layerfs-lab\root\layerfs-next\.agents\skills\layerfs-js-sdk\SKILL.md`.

The bridge works without OMP as well:

```powershell
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh up hello lfsb-rust-sandbox:2
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh cli hello hello.t1 -- status
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh cli hello hello.t1 -- run feat "cargo test"
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh script hello hello.t1 /root/layerfs-bridge/scripts/x.mjs
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh down hello
```

### What each agent sees and keeps

- **Project context.** While `.omp/layerfs.json` exists in the session's folder, every
  agent (the main session and every `task` subagent) gets one line appended to its system
  prompt, as DSH puts it in each agent's runtime context:
  `LayerFS project of this conversation: hello (live). Every layerfs and layerfs_script call
  has it as DSH_LAYERFS_PROJECT; ...` plus the SKILL.md path. The session also gets one
  `layerfs-bridge.prompt` entry recording the line it was given.
- **Call records.** After each `layerfs`/`layerfs_script` call the extension reads the new
  lines of that session's trace file, keeps the finished SDK calls of this tool call
  (matched by the tool-call id the SDK writes as `step`; `start` lines and torn lines are
  skipped), and returns them compactly in the tool result's `details.layerfs`
  (`method`, `ok`, `kind`, `code`/`message` on refusal, `branch`, `commit`/`head`/`layer`,
  `exitCode`, `ms`, `start`, `step`, `project`). Each record is also kept in the calling
  session's file as a custom entry `layerfs-bridge.call` — a subagent's records land in the
  subagent's own session. A nonzero exit is an error result that still carries its records.
- **`/layerfs log [n]`** (default 30): the last `n` finished calls on the bound project
  across all sessions' trace files, oldest first, one line each: time (UTC), short session
  id, method, outcome (`ok <kind>` or `FAIL <code>`), Branch (Workspace calls inherit the
  Branch their Workspace was mounted from), short commit/head, duration.
- **`/layerfs agents`**: per session: number of calls, last call time, Branches touched.

Both commands work without a model turn, e.g.
`omp -p --mode json -e E:\projects\layerfs-bridge\extension\index.ts "/layerfs log 50" < NUL`.

### End-to-end check

`e2e/` holds the end-to-end check: `.omp/layerfs.json` for `hello` and `prompt.md`
(parent status → three parallel `task` subagents fork `a1`, `a2`, `a3`; `a1` and `a3` both
change `/src/lib.rs`, `a2` adds `/src/math.rs`; each runs `cargo test` in a Workspace and
commits → the parent merges them into a release Branch, resolves the `a3` conflict,
publishes to main). Run it from `e2e/`, then the two report commands:

```powershell
cmd /c "omp -p --mode json --model smol -e ..\extension\index.ts @prompt.md < NUL > e2e-events.jsonl"
cmd /c "omp -p --mode json -e ..\extension\index.ts ""/layerfs log 60"" < NUL > cmd-log.jsonl"
cmd /c "omp -p --mode json -e ..\extension\index.ts ""/layerfs agents"" < NUL > cmd-agents.jsonl"
```

### All projects

`/layerfs projects` lists every project in the distro, read-only (it starts, stops and
removes nothing). It needs no binding: in a folder without `.omp/layerfs.json` it uses
`layerfs-lab`; with one, the binding's distro, and the bound project's row is marked `*`
(a note follows when that project is not listed). Without OMP:
`wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh projects`.

```text
docker engine 29.9.2, /var/lib/docker: 897G free of 1007G
  PROJECT  CLIENT   SANDBOX IMAGE        STORE  SANDBOXES             PAGE
* hello    running  lfsb-rust-sandbox:2  16M    0 running, 0 stopped  http://localhost:8788
  katana   running  lfsb-node-sandbox:3  1.1G   0 running, 0 stopped  http://localhost:8787
leftovers: none
```

- **First line:** the Docker Engine version and the free disk under its data root.
- **One row per project** found from an `lfsb-<project>-store` volume or an
  `lfsb-<project>` client (label `lfsb.project`):
  - `CLIENT`: the client container's state, `running`, `stopped` or `missing`.
  - `SANDBOX IMAGE`: the image new Sandboxes run (the client's `LAYERFS_IMAGE`, the
    binding's `image`) as its tag, or a short id when it has no tag.
  - `STORE`: the Store volume's size (`du -sh` of its mountpoint, so a large Store takes
    a while), or `none`.
  - `SANDBOXES`: the containers other than the client that use the Store volume.
    `created`, `exited` and `dead` count as stopped; any other state counts as running.
  - `PAGE`: the project's LayerFS page: its address while it runs, `:<port> (stopped)`
    for a kept port whose page is not running, `-` if it was never started.
- **`leftovers`:**
  - containers labelled `layerfs.role=sandbox` whose Store volume (the one mounted at
    `/layerfs-store`) no longer exists;
  - clients without their Store volume.

  Sandboxes of other LayerFS Stores whose volume still exists are not listed.

### Rotating a project's Store

A LayerFS Store never collects garbage: every Commit, Layer and committed `target/` stays,
so a project's Store volume only grows. Rotation replaces it with a new project seeded
from the files of the current `main`:

```text
/layerfs rotate [new-project]
/layerfs remove <old-project>
```

- **`/layerfs rotate`** runs the bridge's `rotate` with the binding's project and image. On
  success it rewrites `project` in `.omp/layerfs.json` to the new project and says so. The
  new name defaults to `<project>-r<N>` (a trailing `-r<N>` replaced, so `hello-r1` rotates
  to `hello-r2`), with the first `N` whose container and Store volume are free.
- **Rotation keeps only `main`'s files.** The new project starts with one `main` Layer and
  no Branches, Commits or Layers of the old one. Branches whose head no `main` Layer's
  source Commit reaches (through parents and merge parents) are unmerged work: `rotate`
  prints them as `dropped` and goes on. Merge and publish what you need first. It reads
  `main`'s newest Layers only (one bounded operator read); when older ones exist it says
  so, and a Branch published only before them is listed as dropped too.
- `rotate` is refused while a Sandbox of the project runs (a Sandbox closes 2 minutes
  after its last Workspace is unmounted). It exports `main` to
  `/root/layerfs-bridge/exports/<project>-<UTC time>` (the export's Sandbox closes itself
  after 2 idle minutes, so `remove` of the old project waits for it), runs `init` of the
  new project from that folder with the same image, and prints the old
  and new project, the export folder and both Store volumes' sizes. The old project is
  kept; the export folder is a full copy of `main`'s files that you delete yourself.
- **`/layerfs export <linux-dest-dir>`** writes the bound project's `main` into a new or
  empty distro folder: regular files, folders, symlinks and modes (not owners), without the
  paths `main`'s root `/.gitignore` ignores (`target/` and the like; a `.git` folder is
  kept). `main` cannot be mounted, so it forks a Branch `lfsb-export-<time>` from `main` (no
  copy; the Branch stays in the project), mounts it and streams `tar` out of the Workspace.
  The Sandbox image needs `tar`, and `git` when `main` has a `/.gitignore`.
- **`/layerfs remove <project>`** needs the exact name and refuses the project bound to
  the folder. The bridge's `remove <project> <project>` (the name twice) is refused while a
  Sandbox of the project runs (it lists them); otherwise it removes the project's stopped
  Sandboxes, its client container, its Store volume and its trace and `.meta.json` files.
  Folders still bound to a removed project fail until rebound.
- Removing a volume frees space inside the distro's ext4 disk; the distro's `ext4.vhdx` on
  Windows does not shrink by itself (compact it with WSL's own tools).

Without OMP:

```powershell
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh export hello /root/hello-main
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh rotate hello lfsb-rust-sandbox:2
wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh remove hello hello
```

### The LayerFS page

`/layerfs ui [port]` starts the bound project's LayerFS page and prints its address;
`/layerfs ui stop` stops it. Without OMP:
`wsl -d layerfs-lab -u root --exec /opt/layerfs-bridge/lfs-bridge.sh ui hello [port]` and `... ui-stop hello`.

Each project's page is its own server in its own client container, on its own port:

- **The port is kept per project** in `/root/layerfs-bridge/ui-ports` (`<project> <port>`
  lines, written under a lock), so a page keeps its address across stops and restarts.
  Without a port, a project gets its kept port, or the first free one from 8787
  (`LFSB_UI_PORT`) that no other project keeps. A kept port another program took is
  replaced by the next free one, and the move is printed. An explicit port that another
  project's running page holds is refused. `remove` drops the project's line.
- **The project switcher** after the LayerFS mark lists every project in `ui-ports`
  (`GET /bridge/projects`; each other page is asked `GET /bridge/whoami`). Picking one opens
  its port with the same `?pane`. A project whose page is not running is shown as
  stopped and cannot be picked; start it with `/layerfs ui` in its folder.

The page is DSH's own LayerFS view (`dsh/packages/view`, `dsh/packages/model`, served
unbuilt from the checkout) with its Work | History switch: Work has the Branches with
the agents on them, the Store's storage and the project terminal of the calls; History
has the project's tree of Branches, Commits and Layers, the Files at a picked point and
Storage. A third switch, Sandboxes (a port of DSH's project Sandboxes tab), lists each
Sandbox with its Workspaces (Branch, agent, idle time, uncommitted changes) and background
processes, with Unmount / Discard… and Stop… (disabled while an agent's call runs in that
Workspace); it is the server's only write route, `POST /layerfs/project/<p>/runtime`,
JSON-only and same-origin. `?pane=work`, `?pane=history` or `?pane=sandboxes` opens a view.

- **Light or dark:** the switch at the strip's right end flips the page. DSH's view is
  light only (both of its skins, heroes and maids), so the dark look is the page's own:
  `ui/index.html` redraws the heroes skin's colour variables under
  `:root[data-theme="dark"]` and overrides each of the view's rules that paints a light
  colour of its own. A pick is kept in the `lfs-theme` cookie, which every project's page
  shares (cookies ignore the port); with none, the page follows the system's
  `prefers-color-scheme`.
- Every OMP session with a trace file on the project is one agent. The extension writes
  `<project>.<session-id>.meta.json` beside each trace (`parent`: the spawning session, null
  for a conversation's root; `agent`, `name`: the subagent's agent and task name). The most
  recently active root is the view's lead, `main`; a subagent whose task name is unique is
  shown by it; the rest by the last characters of their session id.
- History comes from the Store; the agents' calls are replayed on top of it, as DSH's
  LayerFS tab does, and new calls appear about two seconds after they end (the page
  polls every 1.5 s). Workspaces show while a call has them mounted.
- `ui/server.mjs` runs in the client container (`node`, host network, bound to
  127.0.0.1, which WSL forwards to Windows' localhost; requests with another `Host` are
  refused). It serves DSH's `/layerfs` routes with DSH's own handler (`host/src/route.js`)
  over DSH's trace `Collector` and `TreeReader`; it stands in only for what DSH's runtime
  gives them: the project binding, the SDK client (from the container's `LAYERFS_*`
  environment) and DSH's session records (none here). Its log is `/tmp/lfsb-ui.log`
  in the client container.
- The page's own glue (`ui/page.js`) is the DSH client plugin's TypeScript (`replay.ts`,
  `playback.ts`, `storage.ts`, `LayerFsView.tsx`'s board) in plain JS without React.
  The DSH plugin's Setup, Init and project removal are not part of it.

## Security

- `layerfs_script` runs model-written JavaScript with Node in the project's client
  container, which holds the Docker socket of the `layerfs-lab` distro (it starts sandbox
  containers through it). Code that runs there can control that distro's Docker, so treat
  a `layerfs_script` call like a shell command in the distro.
- Approval tiers (see OMP's approval modes): `layerfs` `status`, `log`, `ls`, `cat`, `grep`
  and `diff` are `read`; `fork` and `write` are `write`; `run` and any other argv are
  `exec`; `layerfs_script` is always `exec`. So `always-ask` asks before `fork`, `write`,
  `run` and scripts, `write` mode asks before `run` and scripts, and `yolo` (OMP's default,
  and every `task` subagent) asks for nothing: set an approval mode to be asked. The prompt
  names the project, the subcommand, its Branch, and for `run` the command; for a script, its
  first 40 lines. `tools.approval.layerfs: allow|deny|prompt` overrides per tool;
  `bash.patterns` rules do not apply to either tool.
- The LayerFS page has no sign-in: anything that reaches `localhost:<port>` (in the distro
  or on Windows) can read the project's History, Files and Store figures. It answers only
  reads with a localhost `Host`, plus the Sandboxes pane's same-origin JSON actions on
  `POST /layerfs/project/<p>/runtime`; DSH's other writes (Init, removal) are refused.

## Type check

`package.json` declares no dependencies. To type-check the extension, install the types in a
scratch folder (`npm i @oh-my-pi/pi-coding-agent@<omp version> typescript @types/node`) and
run `tsc` there with a tsconfig whose `files` names `extension/index.ts` and whose `paths`
maps `@oh-my-pi/pi-coding-agent` to `node_modules/@oh-my-pi/pi-coding-agent/dist/types/index.d.ts`.

## License

MIT, see [LICENSE](LICENSE). Parts of `ui/` are ported from or load LayerFS's `dsh/packages`
(MIT, Copyright (c) 2026 Ephemeral-AI); its notice is in [NOTICE](NOTICE).
