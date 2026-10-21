# omp-layerfs

LayerFS for OMP agents: the DSH LayerFS integration (`dsh-layerfs`) ported to the
OMP coding agent on Windows. Agents fork Branches, run commands in Workspaces,
commit, merge and publish through the LayerFS JS SDK, which runs in a WSL distro.

- `bridge/lfs-bridge.sh`: runs in the distro. One long-lived SDK client container per
  project (`omp-lfs-<project>`, Store volume `omp-lfs-<project>-store`). Each call is one
  `docker exec` with the `DSH_LAYERFS_*` environment a DSH agent's bash call gets,
  so DSH's `lfs.js` and SDK scripts run unchanged. SDK traces go to
  `/root/omp-layerfs/traces/<session-id>.jsonl`, one file per OMP session (a `task`
  subagent has its own).
- `extension/index.ts`: the OMP extension. Tools `layerfs` (an `lfs.js` command) and
  `layerfs_script` (a Node ES module run against the SDK), and the command `/layerfs`.

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

`e2e/` holds the end-to-end check: `.omp/layerfs.json` for `hello` and `prompt.md`
(parent status → one `task` subagent forks `sub-1`, edits, runs `cargo test`, commits →
parent merges and publishes). Run it from `e2e/`:

```powershell
cmd /c "omp -p --mode json --model smol -e ..\extension\index.ts @prompt.md < NUL > e2e-events.jsonl"
```
