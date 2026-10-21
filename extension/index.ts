// OMP extension: work on a LayerFS project the way DSH agents do, through the
// LayerFS JS SDK running in a WSL distro (see ../bridge/lfs-bridge.sh).
//
// The folder's binding is <cwd>/.omp/layerfs.json:
//   { "distro": "layerfs-lab", "project": "hello", "image": "bench-rust-sandbox:3" }
// Every call runs the bridge with the calling session's id as its trace id, so
// each agent (a task subagent has its own session) gets its own SDK trace file
// /root/omp-layerfs/traces/<session-id>.jsonl in the distro.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BRIDGE = "/opt/omp-layerfs/lfs-bridge.sh";
const ROOT = "/root/omp-layerfs";
const DEFAULT_DISTRO = "layerfs-lab";
const SKILL = "/root/layerfs/.agents/skills/layerfs-js-sdk/SKILL.md";
/** Characters kept per output stream; the rest is cut from the middle. */
const STREAM_LIMIT = 60_000;

interface Binding {
	distro: string;
	project: string;
	image: string;
}

interface BridgeResult {
	code: number;
	stdout: string;
	stderr: string;
}

function bindingFile(cwd: string): string {
	return path.join(cwd, ".omp", "layerfs.json");
}

function readBinding(cwd: string): Binding {
	const file = bindingFile(cwd);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		throw new Error(
			`No LayerFS project is bound to ${cwd} (missing ${file}). Run /layerfs init <project> <image> <linux-src-dir> first, or work on the local folder.`,
		);
	}
	const b = JSON.parse(raw) as Partial<Binding>;
	if (!b.project || !b.image) throw new Error(`${file} must name "project" and "image"`);
	return { distro: b.distro || DEFAULT_DISTRO, project: b.project, image: b.image };
}

/** The distro path of a Linux file, as Windows sees it. */
function uncPath(distro: string, linuxPath: string): string {
	return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
}

/** The calling session's id, in the bridge's trace-id alphabet. */
function traceId(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId().replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Runs the bridge in the distro. `wsl.exe --exec` hands the argv to the
 * bridge without a Linux shell, and Node quotes each Windows argument, so
 * arguments arrive byte for byte. `step` labels the SDK trace lines.
 */
function bridge(
	distro: string,
	argv: string[],
	opts: { stdin?: string; signal?: AbortSignal; step?: string } = {},
): Promise<BridgeResult> {
	const env = { ...process.env };
	if (opts.step) {
		env.LFS_TRACE_STEP = opts.step;
		env.WSLENV = env.WSLENV ? `${env.WSLENV}:LFS_TRACE_STEP` : "LFS_TRACE_STEP";
	}
	const { promise, resolve, reject } = Promise.withResolvers<BridgeResult>();
	const child = spawn("wsl.exe", ["-d", distro, "--exec", BRIDGE, ...argv], {
		env,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", (c: Buffer) => out.push(c));
	child.stderr.on("data", (c: Buffer) => err.push(c));
	const abort = () => child.kill();
	opts.signal?.addEventListener("abort", abort, { once: true });
	child.on("error", (e) => {
		opts.signal?.removeEventListener("abort", abort);
		reject(new Error(`could not start wsl.exe: ${e.message}`));
	});
	child.on("close", (code, sig) => {
		opts.signal?.removeEventListener("abort", abort);
		resolve({
			code: code ?? (sig ? 128 : 1),
			// wsl.exe passes Linux UTF-8 through unchanged.
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8"),
		});
	});
	child.stdin.on("error", () => {});
	child.stdin.end(opts.stdin ?? "");
	return promise;
}

function clip(s: string): string {
	if (s.length <= STREAM_LIMIT) return s;
	const half = STREAM_LIMIT / 2;
	return `${s.slice(0, half)}\n… [${s.length - STREAM_LIMIT} characters cut] …\n${s.slice(-half)}`;
}

function format(r: BridgeResult): string {
	const parts: string[] = [];
	if (r.stdout) parts.push(clip(r.stdout.trimEnd()));
	if (r.stderr) parts.push(`[stderr]\n${clip(r.stderr.trimEnd())}`);
	parts.push(`[exit ${r.code}]`);
	return parts.join("\n");
}

/** A tool result; a nonzero exit is a tool error carrying the same text. */
function toolResult(r: BridgeResult) {
	const text = format(r);
	if (r.code !== 0) throw new Error(text);
	return { content: [{ type: "text" as const, text }], details: { exitCode: r.code } };
}

const LAYERFS_DESCRIPTION = `Run one LayerFS CLI command (DSH's lfs.js) on the LayerFS project bound to this folder (.omp/layerfs.json). The project's files live in LayerFS, not in the local folder.
\`args\` is the argv, one element per argument (no shell quoting):
  status                          project and its Branches
  log <branch> [n]                newest Commits of a Branch
  ls <ref> [path]                 list a folder (default /)
  cat <ref> <path>                print a file
  grep <ref> <pattern> [path]     search
  diff <a> <b>                    files that differ between two Branches
  fork <name> [from]              new Branch (from main by default)
  write <branch> <path> [msg]     file content from \`stdin\`, one Commit
  run <branch> <command> [msg]    run the bash command in a new Workspace of the Branch (cwd = project root) and Commit what it changed; add --discard to keep nothing
A ref is main, a Branch, a Commit id or a Layer id; paths are absolute (/src/lib.rs). main is read-only: fork a Branch, work on it, then merge and publish with layerfs_script. A refusal prints \`<Code>: <message>\` and exits 2.`;

function scriptDescription(): string {
	return `Run a Node ES module against the LayerFS JS SDK for this folder's LayerFS project (.omp/layerfs.json) — for what the layerfs CLI lacks: merge, publish, fs.edit/fs.apply, longer Workspace sessions.
Rules:
- Load the SDK with \`const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);\` and open \`new LayerFS(process.env.DSH_LAYERFS_PROJECT)\`.
- main is read-only: fork a Branch, change it, commit, then branch.merge and branch.publish.
- Unmount every Workspace you mount in a finally block, and end with \`await lf.close()\`.
- Print what you need (console.log); a thrown error or nonzero exit is a tool error.
Template:
\`\`\`js
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const lf = new LayerFS(process.env.DSH_LAYERFS_PROJECT);
try {
  // await lf.fs.write("my-branch", "/src/lib.rs", text, "message");     // one Commit, no Workspace
  const ws = await lf.workspace.mount("my-branch");
  try {
    const r = await lf.workspace.exec(ws, "cargo test");                  // { exitCode, stdout, stderr }
    console.log(r.exitCode, r.stdout, r.stderr);
    console.log(await lf.workspace.commit(ws, "message"));               // { kind: "Committed" | "UpToDate", head }
  } finally {
    await lf.workspace.unmount(ws);
  }
  // const m = await lf.branch.merge("my-branch", "main", "my-release", "merge main"); // new Branch m.branch
  // console.log(await lf.branch.publish(m.branch));                    // main now shows it
} finally {
  await lf.close();
}
\`\`\`
Full SDK guide (read before non-trivial work): ${uncPath(DEFAULT_DISTRO, SKILL)} and the references/ folder beside it (methods/project.md, branch.md, workspace.md, fs-read.md, fs-write.md). When the binding names another distro, replace "${DEFAULT_DISTRO}" in that path.`;
}

export default function layerfs(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("LayerFS");

	pi.registerTool({
		name: "layerfs",
		label: "LayerFS",
		description: LAYERFS_DESCRIPTION,
		parameters: z.object({
			args: z.array(z.string()).min(1).describe('lfs.js argv, e.g. ["status"] or ["run", "feat", "cargo test"]'),
			stdin: z.string().optional().describe("standard input (file content for `write`)"),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const b = readBinding(ctx.cwd);
			const r = await bridge(b.distro, ["cli", b.project, traceId(ctx), "--", ...params.args], {
				stdin: params.stdin,
				signal,
				step: toolCallId,
			});
			return toolResult(r);
		},
	});

	pi.registerTool({
		name: "layerfs_script",
		label: "LayerFS script",
		description: scriptDescription(),
		parameters: z.object({
			source: z.string().min(1).describe("ES module source run with node in the LayerFS client"),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const b = readBinding(ctx.cwd);
			const linux = `${ROOT}/scripts/${randomUUID()}.mjs`;
			const file = uncPath(b.distro, linux);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, params.source, "utf8");
			try {
				const r = await bridge(b.distro, ["script", b.project, traceId(ctx), linux], { signal, step: toolCallId });
				return toolResult(r);
			} finally {
				await unlink(file).catch(() => {});
			}
		},
	});

	pi.registerCommand("layerfs", {
		description: "LayerFS project of this folder: init <project> <image> <linux-src-dir> | status | down",
		handler: async (args, ctx) => {
			const [sub, ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const show = (text: string, ok: boolean) => {
				pi.sendMessage({ customType: "layerfs", content: text, display: true });
				ctx.ui.notify(ok ? `layerfs ${sub}: done` : `layerfs ${sub}: failed`, ok ? "info" : "error");
			};
			try {
				if (sub === "init") {
					if (rest.length !== 3) throw new Error("usage: /layerfs init <project> <image> <linux-src-dir>");
					const [project, image, src] = rest;
					let distro = DEFAULT_DISTRO;
					try {
						distro = readBinding(ctx.cwd).distro;
					} catch {}
					const r = await bridge(distro, ["init", project, image, src]);
					if (r.code === 0) {
						const file = bindingFile(ctx.cwd);
						await mkdir(path.dirname(file), { recursive: true });
						await writeFile(file, `${JSON.stringify({ distro, project, image }, null, 2)}\n`, "utf8");
						show(`${format(r)}\nbound ${ctx.cwd} to LayerFS project ${project} (${file})`, true);
					} else show(format(r), false);
				} else if (sub === "status") {
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, ["cli", b.project, traceId(ctx), "--", "status"]);
					show(format(r), r.code === 0);
				} else if (sub === "down") {
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, ["down", b.project]);
					show(format(r), r.code === 0);
				} else {
					throw new Error("usage: /layerfs init <project> <image> <linux-src-dir> | status | down");
				}
			} catch (e) {
				show(e instanceof Error ? e.message : String(e), false);
			}
		},
	});
}
