This folder is bound to the LayerFS project `hello` (a small Rust library crate). Its files live in LayerFS, not in this local folder: use only the `layerfs` and `layerfs_script` tools to touch them. Do these steps in order and do not skip any.

1. Call `layerfs` with args `["status"]`.

2. Spawn exactly ONE subagent with the `task` tool (not isolated). Give it this assignment verbatim:

   > The LayerFS project `hello` (Rust crate; files only in LayerFS, reach them with the `layerfs` and `layerfs_script` tools, never the local folder) needs a new function.
   > a. Fork Branch `sub-1` from main: `layerfs` args `["fork", "sub-1"]`.
   > b. Read `/src/lib.rs` on `sub-1` (`layerfs` args `["cat", "sub-1", "/src/lib.rs"]`).
   > c. With one `layerfs_script` call, edit `/src/lib.rs` on Branch `sub-1` using `lf.fs.edit(branch, path, oldText, newText, message)` (or `lf.fs.write(branch, path, wholeText, message)`): add `pub fn double(x: u64) -> u64 { x * 2 }` after the `greet` function, and a test `#[test] fn doubles() { assert_eq!(double(21), 42); }` inside `mod tests`. Print the result.
   > d. With one `layerfs_script` call: mount a Workspace of `sub-1` (`lf.workspace.mount("sub-1")`), run `cargo test` in it (`lf.workspace.exec(ws, "cargo test")`), print exitCode, stdout and stderr, commit it with `lf.workspace.commit(ws, "sub-1: add double + test")` and print the commit result; unmount in a `finally`; end with `lf.close()`.
   > e. Reply with the test summary line and the commit result. If anything fails, fix it and retry.

3. When the subagent is done, with one `layerfs_script` call: merge (`const m = await lf.branch.merge("sub-1", "main", "sub-1-release", "merge main into sub-1")`), print `m`, then publish (`console.log(await lf.branch.publish(m.branch))`).

4. Call `layerfs` with args `["log", "sub-1-release"]`, then `["status"]`, then `["cat", "main", "/src/lib.rs"]`.

5. Reply with a short summary: subagent's test result and commit, merge result, publish result, and whether main now contains `double`.
