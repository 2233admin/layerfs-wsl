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
client container (the Store volume stays).

Build output is committed with the sources (that is what makes a new Workspace start with
a warm `target/`). So that two Branches that both built can still merge, `init` writes a
root `/.lww` of `%include .gitignore` when the source has none: `.gitignore` paths merge
newer-wins instead of conflicting. They are still stored; the Store never deletes history.
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
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh cli hello t1 -- status
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh cli hello t1 -- run feat "cargo test"
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh script hello t1 /root/omp-layerfs/scripts/x.mjs
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

### The LayerFS page

`/layerfs ui [port]` starts the bound project's LayerFS page and prints its address,
`http://localhost:8787` by default; `/layerfs ui stop` stops it. Without OMP:
`wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh ui hello [port]` and `... ui-stop hello`.
The page is DSH's own LayerFS view (`dsh/packages/view`, `dsh/packages/model`, served
unbuilt from the checkout) with its Work | History switch: Work has the Branches with
the agents on them, the Store's storage and the project terminal of the calls; History
has the project's tree of Branches, Commits and Layers, the Files at a picked point and
Storage. `?pane=work` or `?pane=history` opens that side.

- Every OMP session with a trace file on the project is one agent, named by the last
  characters of its session id (as `/layerfs log` shows them), so the page shows each
  `task` subagent apart. No session is the lead: the view's lead (`main`) stays unassigned.
- History comes from the Store; the agents' calls are replayed on top of it, as DSH's
  LayerFS tab does, and new calls appear about two seconds after they end (the page
  polls every 1.5 s). Workspaces show while a call has them mounted.
- `ui/server.mjs` runs in the client container (`node`, host network, bound to
  127.0.0.1, which WSL forwards to Windows' localhost; requests with another `Host` are
  refused). It serves DSH's `/layerfs` routes with DSH's own handler (`host/src/route.js`)
  over DSH's trace `Collector` and `TreeReader`; it stands in only for what DSH's runtime
  gives them: the project binding, the SDK client (from the container's `LAYERFS_*`
  environment) and DSH's session records (none here). Its log is `/tmp/omp-lfs-ui.log`
  in the client container. One page per project; give two projects different ports.
- The page's own glue (`ui/page.js`) is the DSH client plugin's TypeScript (`replay.ts`,
  `playback.ts`, `storage.ts`, `LayerFsView.tsx`'s board) in plain JS without React.
  The DSH plugin's Setup, Init, project removal and Sandboxes tab are not part of it.

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
  reads with a localhost `Host`; DSH's writes on the same routes (Init, removal, Sandbox
  actions) are refused.

## Type check

`package.json` declares no dependencies. To type-check the extension, install the types in a
scratch folder (`npm i @oh-my-pi/pi-coding-agent@<omp version> typescript @types/node`) and
run `tsc` there with a tsconfig whose `files` names `extension/index.ts` and whose `paths`
maps `@oh-my-pi/pi-coding-agent` to `node_modules/@oh-my-pi/pi-coding-agent/dist/types/index.d.ts`.
