This folder is bound to a LayerFS project (a small Rust library crate). Its files live in LayerFS, not in this local folder: use only the `layerfs` and `layerfs_script` tools to touch them. Do these steps in order and do not skip any. Do not use the `todo` tool (its completion clauses commit this git checkout).

1. Call `layerfs` with args `["status"]`.

2. Spawn THREE subagents with ONE `task` tool call, so they run in parallel. Each task item uses `agent: "task:mid"` and is NOT isolated (`isolated: false`). Give each the assignment below verbatim, with NAME and EDIT filled in from this table:

   | NAME | EDIT |
   | --- | --- |
   | a1 | In `/src/lib.rs` add `pub fn triple(x: u64) -> u64 { x * 3 }` directly after the line `pub fn double(x: u64) -> u64 { x * 2 }`, and the test `#[test] fn triples() { assert_eq!(triple(14), 42); }` as the last item inside `mod tests`. |
   | a2 | Create `/src/math.rs` containing `pub fn square(x: u64) -> u64 { x * x }` and a test module `#[cfg(test)] mod tests { #[test] fn squares() { assert_eq!(super::square(7), 49); } }`, and wire it into the crate by inserting the line `pub mod math;` followed by an empty line at the very top of `/src/lib.rs` (before `pub fn add`). |
   | a3 | In `/src/lib.rs` add `pub fn half(x: u64) -> u64 { x / 2 }` directly after the line `pub fn double(x: u64) -> u64 { x * 2 }`, and the test `#[test] fn halves() { assert_eq!(half(84), 42); }` as the last item inside `mod tests`. |

   Assignment (verbatim, with NAME and EDIT replaced):

   > Your files live only in LayerFS; reach them with the `layerfs` and `layerfs_script` tools, never the local folder. Your Branch is `NAME`.
   > a. Fork Branch `NAME` from main: `layerfs` args `["fork", "NAME"]`.
   > b. Read `/src/lib.rs` on `NAME` (`layerfs` args `["cat", "NAME", "/src/lib.rs"]`).
   > c. Make this change on Branch `NAME` with one `layerfs_script` call, using `lf.fs.edit(branch, path, oldText, newText, message)` for an edit and `lf.fs.write(branch, path, wholeText, message)` for a new file: EDIT Print the results.
   > d. With one `layerfs_script` call: mount a Workspace of `NAME` (`const ws = await lf.workspace.mount("NAME")`), run `cargo test` in it (`await lf.workspace.exec(ws, "cargo test")`), print exitCode, stdout and stderr, commit it with `await lf.workspace.commit(ws, "NAME: cargo test")` and print the commit result; unmount in a `finally`; end with `lf.close()`. If the test fails, fix the code on `NAME` and repeat d.
   > e. Your reply MUST begin with the first sentence of the line in your own system prompt that names the LayerFS project of this conversation, copied exactly, or say "NO PROJECT LINE" if your system prompt has no such line. Then give the cargo test summary line and the commit result.

3. When all three subagents are done, merge with one `layerfs_script` call running exactly this script and print everything it prints:

   ```js
   const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
   const lf = new LayerFS(process.env.DSH_LAYERFS_PROJECT);
   try {
     const m12 = await lf.branch.merge("a1", "a2", "rel-a1a2", "merge a1 and a2");
     console.log("MERGE a1+a2", JSON.stringify(m12, null, 2));
     try {
       const m = await lf.branch.merge("rel-a1a2", "a3", "release", "merge a3");
       console.log("MERGE +a3", JSON.stringify(m, null, 2));
     } catch (e) {
       console.log("MERGE +a3 REFUSED", JSON.stringify({ code: e.code, message: e.message, detail: e.detail }, null, 2));
     }
   } finally {
     await lf.close();
   }
   ```

4. If the second merge was refused with a conflict, resolve it: with `layerfs_script` fork Branch `release` from `rel-a1a2` (`lf.branch.fork("release", "rel-a1a2")`), then re-apply a3's change on `release` with `lf.fs.edit` (add `pub fn half(x: u64) -> u64 { x / 2 }` directly after `pub fn triple(x: u64) -> u64 { x * 3 }`, and the test `#[test] fn halves() { assert_eq!(half(84), 42); }` as the last item inside `mod tests`). Read `/src/lib.rs` on `release` first so your `oldText` matches exactly.

5. With one `layerfs_script` call: mount a Workspace of `release`, run `cargo test`, print exitCode and stdout, commit, unmount in a `finally`. Only if the exit code is 0, publish: `console.log(JSON.stringify(await lf.branch.publish("release"), null, 2))`. End with `lf.close()`.

6. Call `layerfs` with args `["cat", "main", "/src/lib.rs"]`, then `["cat", "main", "/src/math.rs"]`, then `["status"]`.

7. Reply with a short summary: each subagent's first sentence (its project line), test result and commit; both merge results (including the conflict paths); how you resolved the conflict; the release cargo test result; the publish result; whether main now has `triple`, `half` and `square`.
