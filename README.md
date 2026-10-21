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

## Install

Prerequisites in the distro (default `layerfs-lab`): Docker, the LayerFS checkout at
`/root/layerfs`, the Linux bundle at `/root/layerfs-linux-build` (`layerfs-daemon`,
`layerfs.node`), the client image `layerfs-352-runtime:node24` and a sandbox image
(e.g. `bench-rust-sandbox:3`). `OMP_LFS_BUNDLE`, `OMP_LFS_CHECKOUT`, `OMP_LFS_ROOT`
and `OMP_LFS_RUNTIME_IMAGE` override those paths.

Install the bridge (from this folder, PowerShell):

```powershell
wsl -d layerfs-lab -- bash -c "mkdir -p /opt/omp-layerfs && tr -d '\r' < bridge/lfs-bridge.sh > /opt/omp-layerfs/lfs-bridge.sh && chmod 755 /opt/omp-layerfs/lfs-bridge.sh"
```

Load the extension for one project only, either per run:

```powershell
omp -e E:\projects\omp-layerfs\extension\index.ts
```

or by copying/linking `extension/index.ts` to `<project>/.omp/extensions/layerfs.ts`.

## Use

Bind a folder to a project (copies a distro folder into a new LayerFS Store once):

```text
/layerfs init hello bench-rust-sandbox:3 /root/omp-layerfs/fixtures/hello
```

This writes `.omp/layerfs.json` (`{ "distro", "project", "image" }`) in the folder;
without it the tools refuse. `/layerfs status` lists Branches, `/layerfs down` stops the
client container (the Store volume stays).

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
wsl -d layerfs-lab -- /opt/omp-layerfs/lfs-bridge.sh up hello bench-rust-sandbox:3
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

## Security

- `layerfs_script` runs model-written JavaScript with Node in the project's client
  container, which holds the Docker socket of the `layerfs-lab` distro (it starts sandbox
  containers through it). Code that runs there can control that distro's Docker, so treat
  a `layerfs_script` call like a shell command in the distro.
- Both tools use OMP's default `exec` approval tier, so they ask for approval like `bash`
  unless the approval mode is `yolo`. `bash.patterns` allow/deny rules do not apply to them.

## Type check

The repository has no `package.json`. To type-check the extension, install the types in a
scratch folder (`npm i @oh-my-pi/pi-coding-agent@<omp version> typescript @types/node`) and
run `tsc` there with a tsconfig whose `files` names `extension/index.ts` and whose `paths`
maps `@oh-my-pi/pi-coding-agent` to `node_modules/@oh-my-pi/pi-coding-agent/dist/types/index.d.ts`.
