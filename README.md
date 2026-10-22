# omp-layerfs

LayerFS for OMP agents: the DSH LayerFS integration (`dsh-layerfs`) ported to the
OMP coding agent on Windows. Agents fork Branches, run commands in Workspaces,
commit, merge and publish through the LayerFS JS SDK, which runs in a WSL distro.

- `bridge/lfs-bridge.sh`: runs in the distro. One long-lived SDK client container per
  project (`omp-lfs-<project>`, Store volume `omp-lfs-<project>-store`). Each call is one
  `docker exec` with the `DSH_LAYERFS_*` environment a DSH agent's bash call gets,
  so DSH's `lfs.js` and SDK scripts run unchanged. SDK traces go to
  `/root/omp-layerfs/traces/<project>.<session-id>.jsonl`, one file per OMP session and
  project (a `task` subagent has its own session). The SDK's trace lines do not name the
  project, so the file name does.
- `extension/index.ts`: the OMP extension. Tools `layerfs` (an `lfs.js` command) and
  `layerfs_script` (a Node ES module run against the SDK), the command `/layerfs`, the
  project line in each agent's context and per-call records in each session.
- `ui/`: the LayerFS page (DSH's Work/History view) of one project, served from its client
  container; see [The LayerFS page](#the-layerfs-page).

Only `extension/` is OMP's. The bridge is a plain command (`lfs-bridge.sh <subcommand>`, one
`docker exec` per call), so another agent harness that can run a command could drive LayerFS
through it the way the extension does; only OMP has been run end to end. `cli` and `script`
take any trace id (letters, digits, `.`, `_`, `-`); the page finds a session's calls only
when its trace id is `<project>.<session>`.

Built and checked against LayerFS `5fb68dd` (the checkout at `/root/layerfs`). The page runs
DSH host modules (`route.js`, `Collector`, `TreeReader`) and the view unbuilt from that
checkout, so a LayerFS checkout whose `dsh/packages` internals moved can break it.

## Install

Prerequisites in the distro (default `layerfs-lab`): Docker, the LayerFS checkout at
`/root/layerfs`, the Linux bundle at `/root/layerfs-linux-build` (`layerfs-daemon`,
`layerfs.node`), the client image `layerfs-352-runtime:node24` and a sandbox image
(for Rust, `omp-lfs-rust-sandbox:1` from `bridge/rust-sandbox.Dockerfile`). `OMP_LFS_BUNDLE`,
`OMP_LFS_CHECKOUT`, `OMP_LFS_ROOT` and `OMP_LFS_RUNTIME_IMAGE` override those paths.

Install the bridge and the page (from this folder, PowerShell):

```powershell
wsl -d layerfs-lab -- bash -c "mkdir -p /opt/omp-layerfs && tr -d '\r' < bridge/lfs-bridge.sh > /opt/omp-layerfs/lfs-bridge.sh && chmod 755 /opt/omp-layerfs/lfs-bridge.sh"
wsl -d layerfs-lab -- bash -c "mkdir -p /root/omp-layerfs/ui && cp ui/server.mjs ui/page.js ui/index.html /root/omp-layerfs/ui/"
```

Install the extension as a user-scoped OMP plugin. The repository root is the plugin
package (`package.json`, `"omp": { "extensions": ["./extension/index.ts"] }`); `link`
junctions it into `~/.omp/plugins/node_modules/omp-layerfs`, so edits to this checkout take
effect in the next session:

```powershell
omp plugin link E:\projects\omp-layerfs
omp plugin list                      # shows omp-layerfs@0.1.0
```

Every OMP session then loads it, and any folder with `.omp/layerfs.json` works without
`-e`, e.g. from `e2e/`: `omp -p "/layerfs status" < NUL` prints `hello`'s Branches (in
`--mode json` the text arrives as a `layerfs` custom message). `omp plugin disable
omp-layerfs` / `omp plugin enable omp-layerfs` turn it off and on. Passing
`-e E:\projects\omp-layerfs\extension\index.ts` as well still loads it once.

## Use

Bind a folder to a project (copies a distro folder into a new LayerFS Store once):

```text
/layerfs init hello omp-lfs-rust-sandbox:1 /root/omp-layerfs/fixtures/hello
```

This writes `.omp/layerfs.json` (`{ "distro", "project", "image" }`) in the folder;
without it the tools refuse. `/layerfs status` lists Branches, `/layerfs down` stops the
client container (the Store volume stays). `/layerfs projects` lists every project in the
distro ([All projects](#all-projects)). `/layerfs export`, `/layerfs rotate` and
`/layerfs remove` are in [Rotating a project's Store](#rotating-a-projects-store).

Build output is committed with the sources (that is what makes a new Workspace start with
a warm `target/`). So that two Branches that both built can still merge, `init` writes a
root `/.lww` of `%include .gitignore` when the source has none: `.gitignore` paths merge
newer-wins instead of conflicting. They are still stored; the Store never deletes history
(see [Rotating a project's Store](#rotating-a-projects-store)).
Rust, with LayerFS 5fb68dd: merging two Branches whose `target/` holds Cargo incremental
dirs (`target/*/incremental`) fails with `Failed: invalid record: binding kind`; the same
builds merge once that subtree is gone. Either build in a Sandbox image with
`CARGO_INCREMENTAL=0` (recipe and reason in `bridge/rust-sandbox.Dockerfile`), or remove
`target/*/incremental` in the same Workspace command before it commits.

Agents then call, for example:

- `layerfs {"args": ["fork", "feat"]}`, `layerfs {"args": ["run", "feat", "cargo test"]}`,
  `layerfs {"args": ["write", "feat", "/notes.txt"], "stdin": "..."}`. Commands:
  `status | log | ls | cat | grep | diff | fork | write | run`.
- `layerfs_script {"source": "const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK); ..."}`
  for merge, publish and multi-step Workspace work. `main` is read-only: fork, work,
  commit, `branch.merge`, `branch.publish`. The SDK guide is at
  `\\wsl.localhost\layerfs-lab\root\layerfs\.agents\skills\layerfs-js-sdk\SKILL.md`.

The bridge works without OMP as well:

```powershell
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh up hello omp-lfs-rust-sandbox:1
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh cli hello hello.t1 -- status
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh cli hello hello.t1 -- run feat "cargo test"
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh script hello hello.t1 /root/omp-layerfs/scripts/x.mjs
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh down hello
```

### What each agent sees and keeps

- **Project context.** While `.omp/layerfs.json` exists in the session's folder, every
  agent (the main session and every `task` subagent) gets one line appended to its system
  prompt, as DSH puts it in each agent's runtime context:
  `LayerFS project of this conversation: hello (live). Every layerfs and layerfs_script call
  has it as DSH_LAYERFS_PROJECT; ...` plus the SKILL.md path. The session also gets one
  `omp-layerfs.prompt` entry recording the line it was given.
- **Call records.** After each `layerfs`/`layerfs_script` call the extension reads the new
  lines of that session's trace file, keeps the finished SDK calls of this tool call
  (matched by the tool-call id the SDK writes as `step`; `start` lines and torn lines are
  skipped), and returns them compactly in the tool result's `details.layerfs`
  (`method`, `ok`, `kind`, `code`/`message` on refusal, `branch`, `commit`/`head`/`layer`,
  `exitCode`, `ms`, `start`, `step`, `project`). Each record is also kept in the calling
  session's file as a custom entry `omp-layerfs.call` — a subagent's records land in the
  subagent's own session. A nonzero exit is an error result that still carries its records.
- **`/layerfs log [n]`** (default 30): the last `n` finished calls on the bound project
  across all sessions' trace files, oldest first, one line each: time (UTC), short session
  id, method, outcome (`ok <kind>` or `FAIL <code>`), Branch (Workspace calls inherit the
  Branch their Workspace was mounted from), short commit/head, duration.
- **`/layerfs agents`**: per session: number of calls, last call time, Branches touched.

Both commands work without a model turn, e.g.
`omp -p --mode json -e E:\projects\omp-layerfs\extension\index.ts "/layerfs log 50" < NUL`.

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
`wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh projects`.

```text
docker engine 29.9.2, /var/lib/docker: 897G free of 1007G
  PROJECT  CLIENT   SANDBOX IMAGE           STORE  SANDBOXES             PAGE
* hello    running  omp-lfs-rust-sandbox:1  14M    0 running, 0 stopped  http://localhost:8788
  katana   running  omp-lfs-node-sandbox:2  1.1G   0 running, 0 stopped  http://localhost:8787
leftovers: none
```

- **First line:** the Docker Engine version and the free disk under its data root.
- **One row per project** found from an `omp-lfs-<project>-store` volume or an
  `omp-lfs-<project>` client (label `omp-lfs.project`):
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
  `/root/omp-layerfs/exports/<project>-<UTC time>` (the export's Sandbox closes itself
  after 2 idle minutes, so `remove` of the old project waits for it), runs `init` of the
  new project from that folder with the same image, and prints the old
  and new project, the export folder and both Store volumes' sizes. The old project is
  kept; the export folder is a full copy of `main`'s files that you delete yourself.
- **`/layerfs export <linux-dest-dir>`** writes the bound project's `main` into a new or
  empty distro folder: regular files, folders, symlinks and modes (not owners), without the
  paths `main`'s root `/.gitignore` ignores (`target/` and the like; a `.git` folder is
  kept). `main` cannot be mounted, so it forks a Branch `omp-export-<time>` from `main` (no
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
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh export hello /root/hello-main
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh rotate hello omp-lfs-rust-sandbox:1
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh remove hello hello
```

### The LayerFS page

`/layerfs ui [port]` starts the bound project's LayerFS page and prints its address;
`/layerfs ui stop` stops it. Without OMP:
`wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh ui hello [port]` and `... ui-stop hello`.

Each project's page is its own server in its own client container, on its own port:

- **The port is kept per project** in `/root/omp-layerfs/ui-ports` (`<project> <port>`
  lines, written under a lock), so a page keeps its address across stops and restarts.
  Without a port, a project gets its kept port, or the first free one from 8787
  (`OMP_LFS_UI_PORT`) that no other project keeps. A kept port another program took is
  replaced by the next free one, and the move is printed. An explicit port that another
  project's running page holds is refused. `remove` drops the project's line.
- **The project switcher** after the LayerFS mark lists every project in `ui-ports`
  (`GET /omp/projects`; each other page is asked `GET /omp/whoami`). Picking one opens
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
  environment) and DSH's session records (none here). Its log is `/tmp/omp-lfs-ui.log`
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
(MIT, Copyright (c) 2026 Ephemeral-AI); its notice is in LICENSE.
