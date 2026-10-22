# Other agent harnesses

`lfs-wsl.sh` is a plain command, so any agent that can run a shell command on Windows can
work on a LayerFS project the way the OMP extension's tools do. Below is the instruction
file Claude Code (2.1.287, `claude-sonnet-5-5`) was given; with it, a non-interactive run
forked a Branch of `hello`, added a function and a test, ran `cargo test` in a Workspace
(7 passed), committed and merged with another Branch, in about 80 seconds and 8 turns, on
both the 5fb68dd and the e49d1613f core. Its calls appear on the LayerFS page like an
OMP session's.

Run it from a folder outside any git repository, with the file below as that folder's
`CLAUDE.md` (other harnesses: their own instruction file), e.g.:

```bash
claude -p "$(<task.txt)" --permission-mode dontAsk --allowedTools Bash Read Write Edit Glob Grep \
  --add-dir '\\wsl.localhost\layerfs-lab\root\layerfs-wsl\scripts' --max-turns 60 < /dev/null
```

What the OMP extension does that such a harness has to be told, or does without:

- **The trace id.** The extension derives `<project>.<session id>` per session; here it is
  fixed in the file, so every run of that file is one agent on the page.
- **Approvals.** The extension grades `layerfs` calls read / write / exec; a harness sees
  only its own shell permission.
- **Project context and call records.** No project line in the system prompt, no
  `layerfs-wsl.call` records, no `/layerfs log|agents`; the trace files still have every
  call, and the page reads them.
- **Argument passing.** Call `lfs-wsl.sh` with `wsl.exe -d layerfs-lab -u root --exec ...`, which
  hands it the arguments as they are. `wsl.exe ... -- ...` runs them through the distro's
  shell first, which expands `$PWD` and other `$` words in a `run` command to the distro
  side's values (Claude's first run got `/mnt/e/tmp/cc-harness` for `$PWD`). Git Bash also
  rewrites Linux paths (`/opt/...`, `/src/lib.rs`) unless `MSYS_NO_PATHCONV=1` is set.

## Instruction file

Replace `<project>` and `<session>` (letters, digits, `_`, `-`).

````markdown
# Working on the LayerFS project `<project>`

The code you work on is NOT in this folder. It is the project `<project>` stored in
LayerFS, inside the WSL distro `layerfs-lab`. Reach it only through the `lfs-wsl.sh` command:

    MSYS_NO_PATHCONV=1 wsl.exe -d layerfs-lab -u root --exec /opt/layerfs-wsl/lfs-wsl.sh <subcommand> ...

Always keep the `MSYS_NO_PATHCONV=1` prefix and `--exec`: your Bash is Git Bash, which
otherwise rewrites Linux paths such as `/opt/...` or `/src/lib.rs` into Windows paths, and
without `--exec` the distro's shell would expand `$` words in your arguments.

## Your session

- Project: `<project>`
- Trace id: `<project>.<session>`: use exactly this on every call. Every call is
  recorded under it in `/root/layerfs-wsl/traces/<project>.<session>.jsonl`.

## CLI: one command per call

    MSYS_NO_PATHCONV=1 wsl.exe -d layerfs-lab -u root --exec /opt/layerfs-wsl/lfs-wsl.sh cli <project> <project>.<session> -- <args>

`<args>` is one of:

    status                         project and its Branches
    log <branch> [n]               newest Commits of a Branch
    ls <ref> [path]                list a folder (default /)
    cat <ref> <path>               print a file
    grep <ref> <pattern> [path]    search
    diff <a> <b>                   files that differ between two Branches
    fork <name> [from]             new Branch (from main by default)
    write <branch> <path> [msg]    file content from stdin, one Commit
    run <branch> <command> [msg]   run the bash command in a new Workspace of the
                                   Branch (cwd = project root) and Commit what it
                                   changed; add --discard to keep nothing

A ref is `main`, a Branch, a Commit id or a Layer id; paths are absolute (`/src/main.rs`).
Pass `run`'s command as ONE quoted argument. A refusal prints `<Code>: <message>` and
exits 2: read it before you retry; never resend the same call blindly.

`write` reads the file from stdin, e.g.

    cat new_lib.rs | MSYS_NO_PATHCONV=1 wsl.exe -d layerfs-lab -u root --exec /opt/layerfs-wsl/lfs-wsl.sh cli <project> <project>.<session> -- write my-branch /src/lib.rs "add foo"

## Rules

- `main` is read-only and you must NOT publish to it. Fork your own Branch, work there.
- Never change or delete Branches you did not create.
- Rust builds in a Workspace: keep the Cargo state inside the project, with relative
  paths (your shell would expand `$PWD` before the Workspace sees it), and bound the time:

      run <branch> "timeout 110 bash -c 'export CARGO_HOME=.cargo-home CARGO_TARGET_DIR=target CARGO_NET_RETRY=0; cargo test --offline'" "cargo test"

  (drop `--offline` if dependencies are missing). A nonzero exit of the command is
  not a refusal; read its output.

## Script: what the CLI lacks (merge, fs.edit, longer Workspace sessions)

The CLI has no merge. For that, write a Node ES module and run it:

1. Create it at `\\wsl.localhost\layerfs-lab\root\layerfs-wsl\scripts\<session>-<name>.mjs`
   (Linux path `/root/layerfs-wsl/scripts/<session>-<name>.mjs`).
2. Run it:

       MSYS_NO_PATHCONV=1 wsl.exe -d layerfs-lab -u root --exec /opt/layerfs-wsl/lfs-wsl.sh script <project> <project>.<session> /root/layerfs-wsl/scripts/<session>-<name>.mjs

Template:

```js
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const lf = new LayerFS(process.env.DSH_LAYERFS_PROJECT);
try {
  // await lf.fs.write("my-branch", "/src/lib.rs", text, "message");   // one Commit
  // const ws = await lf.workspace.mount("my-branch");
  // try { const r = await lf.workspace.exec(ws, "cargo test");        // { exitCode, stdout, stderr }
  //       console.log(await lf.workspace.commit(ws, "message")); }     // { kind, head }
  // finally { await lf.workspace.unmount(ws); }
  const m = await lf.branch.merge("branch-a", "branch-b", "new-branch", "merge message");
  console.log(JSON.stringify(m));                                       // new Branch m.branch
  // DO NOT call lf.branch.publish here.
} finally {
  await lf.close();
}
```

A refused SDK call throws a `LayerFSError` with `code`, `message`, `detail`; print them.
`Conflict` on merge means the Branches changed the same file differently; report it.
Full SDK guide: `\\wsl.localhost\layerfs-lab\root\layerfs-next\.agents\skills\layerfs-js-sdk\SKILL.md`
(and `references/` beside it, e.g. `references/methods/branch.md`, `references/rules/cargo.md`).
````
