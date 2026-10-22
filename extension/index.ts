// OMP extension: work on a LayerFS project the way DSH agents do, through the
// LayerFS JS SDK running in a WSL distro (see ../bridge/lfs-wsl.sh).
//
// The folder's binding is <cwd>/.omp/layerfs.json:
//   { "distro": "layerfs-lab", "project": "hello", "image": "lfsb-rust-sandbox:1" }
// Every call runs the bridge with trace id `<project>.<session-id>`, so each
// agent (a task subagent has its own session) gets its own SDK trace file
// /root/layerfs-wsl/traces/<project>.<session-id>.jsonl in the distro. The SDK's
// trace lines do not name the project; the file name does.
// Beside it, <project>.<session-id>.meta.json records the session's lineage
// (root session or subagent of which), by which the LayerFS page names agents.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";

const BRIDGE = "/opt/layerfs-wsl/lfs-wsl.sh";
const ROOT = "/root/layerfs-wsl";
const TRACES = `${ROOT}/traces`;
const DEFAULT_DISTRO = "layerfs-lab";
/** The SDK guide in the bridge's core checkout (LFSB_CHECKOUT default /root/layerfs-next). */
const SKILL = "/root/layerfs-next/.agents/skills/layerfs-js-sdk/SKILL.md";
/** Characters kept per output stream; the rest is cut from the middle. */
const STREAM_LIMIT = 60_000;
/** The SDK cuts trace step labels to this many characters (sdk/js/src/trace.js). */
const STEP_LIMIT = 200;
/** Custom session entry of one traced LayerFS call. */
const CALL_ENTRY = "layerfs-wsl.call";
/** Custom session entry recording the project line given to a session. */
const PROMPT_ENTRY = "layerfs-wsl.prompt";

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

/** One parsed SDK trace line. */
type TraceLine = Record<string, unknown>;

/** A traced LayerFS call, compact: ids and outcome, no arguments or output. */
interface CallRecord {
	project: string;
	id: string;
	step?: string;
	method: string;
	start: string;
	ms?: number;
	ok: boolean;
	kind?: string;
	code?: string;
	message?: string;
	branch?: string;
	commit?: string;
	head?: string;
	layer?: string;
	exitCode?: number;
}

/** Workspaces seen mounted, `${sandbox}\n${path}` -> Branch: workspace calls name no Branch themselves. */
type Mounts = Map<string, string>;

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

/** Points the folder's binding at another project, keeping its other fields; returns the file. */
async function rebind(cwd: string, project: string): Promise<string> {
	const file = bindingFile(cwd);
	const b = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
	await writeFile(file, `${JSON.stringify({ ...b, project }, null, 2)}\n`, "utf8");
	return file;
}

/** The distro path of a Linux file, as Windows sees it. */
function uncPath(distro: string, linuxPath: string): string {
	return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
}

/**
 * The trace id of the calling session's calls on `project`: `<project>.<session>`,
 * in the bridge's trace-id alphabet. The session part has no dots, so the last
 * dot of a trace file name separates project and session.
 */
function traceId(project: string, ctx: { sessionManager: { getSessionId(): string } }): string {
	return `${project}.${tracePart(ctx.sessionManager.getSessionId())}`;
}

/** A session id in the bridge's trace-id alphabet. */
function tracePart(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function traceFile(distro: string, id: string): string {
	return uncPath(distro, `${TRACES}/${id}.jsonl`);
}

// ---- lineage sidecar ------------------------------------------------------------

type SessionContext = {
	sessionManager: Pick<ReadonlySessionManager, "getSessionId" | "getSessionFile" | "getHeader" | "getEntries">;
};

/**
 * <trace id>.meta.json beside a trace file: who the trace's session is, for
 * ui/server.mjs to name agents (a conversation's root session is its lead, `main`).
 * `parent` is the trace-id session part of the session that spawned this one, null
 * for a root; `agent` the subagent's agent definition (`task:mid`), `name` its task
 * name (`a1`).
 */
interface Lineage {
	parent: string | null;
	agent: string | null;
	name: string | null;
}

/**
 * The session id a header's `parentSession` names: a session id, or a session file
 * whose header carries the id (a subagent's file is `<task name>.jsonl`, so the id is
 * not in its name; a root's file name ends `_<id>.jsonl`).
 */
async function sessionIdOf(parentSession: string): Promise<string | null> {
	if (!/[\\/]/.test(parentSession)) return parentSession;
	try {
		const fh = await open(parentSession, "r");
		try {
			// the header follows the fixed-width title slot (SESSION_TITLE_SLOT_BYTES)
			const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
			for (const raw of buffer.toString("utf8", 0, bytesRead).split("\n")) {
				try {
					const entry = JSON.parse(raw) as { type?: unknown; id?: unknown };
					if (entry.type === "session" && str(entry.id)) return entry.id as string;
				} catch {}
			}
		} finally {
			await fh.close();
		}
	} catch {}
	return /_([0-9A-Za-z-]+)\.jsonl$/.exec(parentSession)?.[1] ?? null;
}

/**
 * The calling session's lineage. Only subagent sessions carry a `session_init` entry
 * (their spawn context); a session without one is a conversation's root, whatever its
 * header's `parentSession` says (forks and moved siblings name the session they came from).
 */
async function lineageOf(ctx: SessionContext): Promise<Lineage> {
	const sm = ctx.sessionManager;
	let init: { agent?: string } | undefined;
	for (const entry of sm.getEntries()) if (entry.type === "session_init") init = entry;
	if (!init) return { parent: null, agent: null, name: null };
	const from = sm.getHeader()?.parentSession;
	const parent = from ? await sessionIdOf(from) : null;
	const file = sm.getSessionFile();
	return {
		parent: parent === null ? null : tracePart(parent),
		agent: init.agent ?? null,
		name: file ? path.basename(file, ".jsonl") : null,
	};
}

/** Trace ids whose lineage sidecar this process has written. */
const described = new Set<string>();

/**
 * Writes the trace's lineage sidecar once per process, before its first call: whole,
 * through a rename. A failure only costs the page the session's name, and the next
 * call tries again; two concurrent first calls write the same content twice.
 */
async function writeLineage(distro: string, trace: string, ctx: SessionContext): Promise<void> {
	if (described.has(trace)) return;
	const file = uncPath(distro, `${TRACES}/${trace}.meta.json`);
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(temp, `${JSON.stringify(await lineageOf(ctx))}\n`, "utf8");
		await rename(temp, file);
		described.add(trace);
	} catch {
		await unlink(temp).catch(() => {});
	}
}

/** The line DSH puts in each agent's context (dsh/packages/host/src/env.js projectContext). */
function projectLine(b: Binding): string {
	return `LayerFS project of this conversation: ${b.project} (live). Every layerfs and layerfs_script call has it as DSH_LAYERFS_PROJECT; work on it through those two tools (the LayerFS CLI and SDK scripts), not the local folder. SDK guide: ${uncPath(b.distro, SKILL)}`;
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
	// as root: the bridge needs the distro's Docker and /root; an Ubuntu distro may have a default user
	const child = spawn("wsl.exe", ["-d", distro, "-u", "root", "--exec", BRIDGE, ...argv], {
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

// ---- SDK trace lines -> call records ----------------------------------------

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
}

/** A complete trace line, or undefined for a torn or foreign one. */
function parseLine(raw: string): TraceLine | undefined {
	if (!raw.trim()) return undefined;
	try {
		const line = JSON.parse(raw) as unknown;
		if (line && typeof line === "object" && (line as TraceLine).layerfs_trace === 1) return line as TraceLine;
	} catch {}
	return undefined;
}

/**
 * The record of a finished call (an `end` line; `start` lines only mark running
 * calls). Updates `mounts` so later workspace calls name their Branch.
 */
function toRecord(line: TraceLine, project: string, mounts: Mounts): CallRecord | undefined {
	if (line.phase === "start") return undefined;
	const id = str(line.id);
	const method = str(line.method);
	if (!id || !method) return undefined;
	const args = (line.args && typeof line.args === "object" ? line.args : {}) as TraceLine;
	const ws = str(args.sandbox) && str(args.path) ? `${args.sandbox}\n${args.path}` : undefined;
	const branch = str(line.branch) ?? str(args.branch) ?? (ws ? mounts.get(ws) : undefined);
	if (method === "workspace.mount" && line.ok === true && str(line.sandbox) && str(line.path) && branch) {
		mounts.set(`${line.sandbox}\n${line.path}`, branch);
	} else if (method === "workspace.unmount" && ws) mounts.delete(ws);
	const rec: CallRecord = { project, id, method, start: str(line.start) ?? "", ok: line.ok === true };
	const step = str(line.step);
	if (step) rec.step = step;
	if (typeof line.ms === "number") rec.ms = line.ms;
	const kind = str(line.kind);
	if (kind) rec.kind = kind;
	const code = str(line.code);
	if (code) rec.code = code;
	const message = str(line.message);
	if (message) rec.message = message.length > 300 ? `${message.slice(0, 300)}…` : message;
	if (branch) rec.branch = branch;
	for (const key of ["commit", "head", "layer"] as const) {
		const v = str(line[key]);
		if (v) rec[key] = v;
	}
	if (Number.isInteger(line.exitCode)) rec.exitCode = line.exitCode as number;
	return rec;
}

/** How far one trace file has been read, by this process. */
interface Tail {
	/** Settles once `offset` holds the file's size before the session's first call here. */
	ready: Promise<void>;
	/** Byte offset after the last complete line read. */
	offset: number;
	/** Read end lines no call has claimed yet (calls of one session can overlap). */
	pending: TraceLine[];
	mounts: Mounts;
	/** Serializes reads of this file. */
	lock: Promise<unknown>;
}

/** Trace id -> tail. Module-wide: every session of this process shares the module. */
const tails = new Map<string, Tail>();

/** The tail of a trace file; created (offset = current size) before its first call runs. */
function tailOf(id: string, file: string): Tail {
	let tail = tails.get(id);
	if (!tail) {
		const t: Tail = { ready: Promise.resolve(), offset: 0, pending: [], mounts: new Map(), lock: Promise.resolve() };
		t.ready = stat(file).then(
			(s) => {
				t.offset = s.size;
			},
			() => {},
		);
		t.lock = t.ready;
		tails.set(id, t);
		tail = t;
	}
	return tail;
}

/** Reads the complete lines appended to `file` since the last read into `tail.pending`. */
function readNew(tail: Tail, file: string): Promise<void> {
	const run = tail.lock.then(async () => {
		let fh: FileHandle;
		try {
			fh = await open(file, "r");
		} catch {
			return;
		}
		try {
			const { size } = await fh.stat();
			if (size <= tail.offset) return;
			const buf = Buffer.alloc(size - tail.offset);
			const { bytesRead } = await fh.read(buf, 0, buf.length, tail.offset);
			const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
			if (end < 0) return;
			tail.offset += end + 1;
			for (const raw of buf.subarray(0, end).toString("utf8").split("\n")) {
				const line = parseLine(raw);
				if (line && line.phase !== "start") tail.pending.push(line);
			}
		} finally {
			await fh.close();
		}
	});
	tail.lock = run.catch(() => {});
	return run;
}

/** The step label the SDK writes for a tool call id. */
function stepLabel(toolCallId: string): string {
	return toolCallId.length > STEP_LIMIT ? `${toolCallId.slice(0, STEP_LIMIT)}…` : toolCallId;
}

/** Takes this call's finished lines (by step label) out of the tail, as records; drops unlabelled lines (`/layerfs status`). */
function claim(tail: Tail, project: string, toolCallId: string): CallRecord[] {
	const step = stepLabel(toolCallId);
	const out: CallRecord[] = [];
	const rest: TraceLine[] = [];
	for (const line of tail.pending) {
		if (line.step !== step) {
			if (line.step !== undefined) rest.push(line);
			continue;
		}
		const rec = toRecord(line, project, tail.mounts);
		if (rec) out.push(rec);
	}
	tail.pending = rest;
	return out;
}

// ---- tool calls ---------------------------------------------------------------

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

// ---- approval ------------------------------------------------------------------

type Tier = "read" | "write" | "exec";

/** Approval tier of each `layerfs` subcommand; any other argv is `exec`. */
const SUBCOMMAND_TIER: Record<string, Tier> = {
	status: "read",
	log: "read",
	ls: "read",
	cat: "read",
	grep: "read",
	diff: "read",
	fork: "write",
	write: "write",
	run: "exec",
};
/** Lines of a `layerfs_script` source shown in its approval prompt. */
const SCRIPT_PREVIEW_LINES = 40;

/** The argv of a `layerfs` call. Approval hooks get the raw arguments, so nothing is assumed about them. */
function cliArgv(args: unknown): unknown[] {
	const argv = (args as { args?: unknown } | null)?.args;
	return Array.isArray(argv) ? argv : [];
}

function cliTier(args: unknown): Tier {
	const sub = cliArgv(args)[0];
	return typeof sub === "string" && Object.hasOwn(SUBCOMMAND_TIER, sub) ? SUBCOMMAND_TIER[sub] : "exec";
}

function projectDetail(cwd: string): string {
	try {
		const b = readBinding(cwd);
		return `Project: ${b.project} (distro ${b.distro})`;
	} catch {
		return `Project: none bound to ${cwd}`;
	}
}

/** Approval prompt lines of a `layerfs` call: project, subcommand, its Branch or ref, and for `run` the command. */
function cliDetails(cwd: string, args: unknown): string[] {
	const argv = cliArgv(args).map(String);
	const [sub = "", ...rest] = argv;
	// lfs.js drops `--discard` wherever it stands; every other argument is positional.
	const [first = "?", second] = rest.filter((a) => a !== "--discard");
	const lines = [projectDetail(cwd), `Subcommand: ${sub || "(none)"}`];
	switch (sub) {
		case "status":
			break;
		case "run":
			lines.push(`Branch: ${first}`, `Command: ${second ?? "?"}`);
			if (rest.includes("--discard")) lines.push("Keeps nothing (--discard)");
			break;
		case "fork":
			lines.push(`Branch: ${first} (from ${second ?? "main"})`);
			break;
		case "write":
			lines.push(`Branch: ${first}`, `Path: ${second ?? "?"}`);
			break;
		case "log":
			lines.push(`Branch: ${first}`);
			break;
		case "diff":
			lines.push(`Branches: ${first} ${second ?? "?"}`);
			break;
		case "ls":
		case "cat":
		case "grep":
			lines.push(`Ref: ${first}`);
			break;
		default:
			lines.push(`Arguments: ${JSON.stringify(argv)}`);
	}
	return lines;
}

/** Approval prompt lines of a `layerfs_script` call: project and the script's first lines. */
function scriptDetails(cwd: string, args: unknown): string[] {
	const source = (args as { source?: unknown } | null)?.source;
	const lines = typeof source === "string" ? source.split("\n") : [];
	const shown = lines.slice(0, SCRIPT_PREVIEW_LINES);
	if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`);
	return [projectDetail(cwd), "Script (node, in the project's client container):", ...shown];
}

// ---- /layerfs log, /layerfs agents --------------------------------------------

/** A finished call of some session, from the trace files. */
interface LoggedCall extends CallRecord {
	session: string;
}

/** Every finished call on `b.project` in the distro's trace files, oldest first. */
async function projectCalls(b: Binding): Promise<LoggedCall[]> {
	const dir = uncPath(b.distro, TRACES);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const lines: { session: string; line: TraceLine }[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const id = name.slice(0, -".jsonl".length);
		const dot = id.lastIndexOf(".");
		if (dot < 0 || id.slice(0, dot) !== b.project) continue;
		const session = id.slice(dot + 1);
		let text: string;
		try {
			text = await readFile(path.join(dir, name), "utf8");
		} catch {
			continue;
		}
		for (const raw of text.split("\n")) {
			const line = parseLine(raw);
			if (line && line.phase !== "start") lines.push({ session, line });
		}
	}
	lines.sort((x, y) => Date.parse(String(x.line.start)) - Date.parse(String(y.line.start)));
	const mounts = new Map<string, Mounts>();
	const out: LoggedCall[] = [];
	for (const { session, line } of lines) {
		let m = mounts.get(session);
		if (!m) mounts.set(session, (m = new Map()));
		const rec = toRecord(line, b.project, m);
		if (rec) out.push({ ...rec, session });
	}
	return out;
}

/** Session ids of one process share their leading time bits; the tail tells them apart. */
function shortSession(s: string): string {
	return s.length > 12 ? `…${s.slice(-8)}` : s;
}

function shortTime(iso: string): string {
	return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z` : "?";
}

function logLine(c: LoggedCall): string {
	const outcome = c.ok ? `ok${c.kind ? ` ${c.kind}` : ""}` : `FAIL ${c.code ?? c.kind ?? ""}`.trimEnd();
	const ref = c.commit ?? c.head;
	return [
		shortTime(c.start),
		shortSession(c.session),
		c.method,
		outcome,
		c.branch ?? "-",
		ref ? ref.slice(0, 12) : "-",
		c.ms === undefined ? "-" : `${c.ms}ms`,
	].join("  ");
}

function agentsReport(project: string, calls: LoggedCall[]): string {
	const by = new Map<string, { calls: number; branches: Set<string>; first: string; last: string }>();
	for (const c of calls) {
		let a = by.get(c.session);
		if (!a) by.set(c.session, (a = { calls: 0, branches: new Set(), first: c.start, last: c.start }));
		a.calls++;
		if (c.branch) a.branches.add(c.branch);
		a.last = c.start;
	}
	if (by.size === 0) return `no traced LayerFS calls on project ${project}`;
	const rows = [...by].map(
		([s, a]) =>
			`${s}  ${a.calls} calls  last ${shortTime(a.last)}  branches: ${[...a.branches].join(", ") || "-"}`,
	);
	return [`${by.size} sessions with LayerFS calls on project ${project} (first call order):`, ...rows].join("\n");
}

/**
 * The bridge's `projects` output with the bound project's row marked `*`: rows are
 * the indented lines after the `  PROJECT` header, before `leftovers`.
 */
function markProject(out: string, project: string): string {
	const lines = out.trimEnd().split("\n");
	const header = lines.findIndex((l) => l.startsWith("  PROJECT "));
	let found = false;
	for (let i = header + 1; header >= 0 && i < lines.length && lines[i].startsWith("  "); i++) {
		if (lines[i].slice(2).split(/\s+/, 1)[0] === project) {
			lines[i] = `* ${lines[i].slice(2)}`;
			found = true;
		}
	}
	if (!found) lines.push(`(the project bound to this folder, ${project}, is not among them)`);
	return lines.join("\n");
}

export default function layerfs(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("LayerFS");

	/** Sessions already given a layerfs-wsl.prompt entry, by session id + project. */
	const prompted = new Set<string>();

	// DSH puts the conversation's project in every agent's runtime context; so do we,
	// in this session and (factories are rebound to them) in every subagent session.
	pi.on("before_agent_start", (event, ctx) => {
		let b: Binding;
		try {
			b = readBinding(ctx.cwd);
		} catch {
			return undefined;
		}
		const line = projectLine(b);
		const key = `${ctx.sessionManager.getSessionId()}\n${b.project}`;
		if (!prompted.has(key)) {
			prompted.add(key);
			pi.appendEntry(PROMPT_ENTRY, { project: b.project, distro: b.distro, line });
		}
		if (event.systemPrompt.includes(line)) return undefined;
		return { systemPrompt: [...event.systemPrompt, line] };
	});

	/**
	 * Runs one bridge call for a tool and returns the tool result: the output
	 * text, and in `details.layerfs` the call's traced SDK calls, each also kept
	 * in the session as a layerfs-wsl.call entry. A nonzero exit is an error
	 * result carrying the same text and records.
	 */
	async function traced(
		b: Binding,
		ctx: SessionContext,
		toolCallId: string,
		run: (trace: string) => Promise<BridgeResult>,
	) {
		const trace = traceId(b.project, ctx);
		const file = traceFile(b.distro, trace);
		const tail = tailOf(trace, file);
		await Promise.all([tail.ready, writeLineage(b.distro, trace, ctx)]);
		const r = await run(trace);
		let records: CallRecord[] = [];
		try {
			await readNew(tail, file);
			records = claim(tail, b.project, toolCallId);
		} catch {}
		for (const rec of records) pi.appendEntry(CALL_ENTRY, rec);
		return {
			content: [{ type: "text" as const, text: format(r) }],
			details: { exitCode: r.code, layerfs: records },
			isError: r.code !== 0,
		};
	}

	/**
	 * Folder of the latest session with a UI. Approval prompts only appear there (headless
	 * sessions such as subagents never prompt), and approval hooks get no context, so the
	 * prompt details read the binding from it.
	 */
	let promptCwd: string | undefined;
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) promptCwd = ctx.cwd;
		return undefined;
	});
	// ToolDefinition's type lacks formatApprovalDetails, but RegisteredToolAdapter forwards
	// every definition key to the approval gate; spread so the literal is not excess-checked.
	const cliApproval = {
		approval: cliTier,
		formatApprovalDetails: (args: unknown) => cliDetails(promptCwd ?? process.cwd(), args),
	};
	const scriptApproval = {
		approval: "exec" as const,
		formatApprovalDetails: (args: unknown) => scriptDetails(promptCwd ?? process.cwd(), args),
	};

	// Explicit schema type arguments: registerTool does not infer them from a zod schema.
	const cliParams = z.object({
		args: z.array(z.string()).min(1).describe('lfs.js argv, e.g. ["status"] or ["run", "feat", "cargo test"]'),
		stdin: z.string().optional().describe("standard input (file content for `write`)"),
	});
	pi.registerTool<typeof cliParams>({
		name: "layerfs",
		label: "LayerFS",
		description: LAYERFS_DESCRIPTION,
		parameters: cliParams,
		...cliApproval,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const b = readBinding(ctx.cwd);
			return traced(b, ctx, toolCallId, (trace) =>
				bridge(b.distro, ["cli", b.project, trace, "--", ...params.args], {
					stdin: params.stdin,
					signal,
					step: toolCallId,
				}),
			);
		},
	});

	const scriptParams = z.object({
		source: z.string().min(1).describe("ES module source run with node in the LayerFS client"),
	});
	pi.registerTool<typeof scriptParams>({
		name: "layerfs_script",
		label: "LayerFS script",
		description: scriptDescription(),
		parameters: scriptParams,
		...scriptApproval,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const b = readBinding(ctx.cwd);
			const linux = `${ROOT}/scripts/${randomUUID()}.mjs`;
			const file = uncPath(b.distro, linux);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, params.source, "utf8");
			try {
				return await traced(b, ctx, toolCallId, (trace) =>
					bridge(b.distro, ["script", b.project, trace, linux], { signal, step: toolCallId }),
				);
			} finally {
				await unlink(file).catch(() => {});
			}
		},
	});

	const USAGE =
		"usage: /layerfs init <project> <image> <linux-src-dir> [distro] | status | down | log [n] | agents | ui [port] | ui stop | export <linux-dest-dir> | rotate [new-project] | remove <project> | projects";

	pi.registerCommand("layerfs", {
		description:
			"LayerFS project of this folder: init <project> <image> <linux-src-dir> [distro] | status | down | log [n] | agents | ui [port] | ui stop | export <linux-dest-dir> | rotate [new-project] | remove <project> | projects (every project in the distro)",
		handler: async (args, ctx) => {
			const [sub, ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			const show = (text: string, ok: boolean) => {
				pi.sendMessage({ customType: "layerfs", content: text, display: true });
				// Text print mode prints only assistant text; json/rpc already carry the message.
				if (ctx.mode === "print") process.stdout.write(`${text}\n`);
				ctx.ui.notify(ok ? `layerfs ${sub}: done` : `layerfs ${sub}: failed`, ok ? "info" : "error");
			};
			try {
				if (sub === "init") {
					if (rest.length !== 3 && rest.length !== 4)
						throw new Error("usage: /layerfs init <project> <image> <linux-src-dir> [distro]");
					const [project, image, src, named] = rest;
					// the distro: as named, else the folder's current binding's, else the default
					let distro = named ?? DEFAULT_DISTRO;
					if (!named)
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
					const trace = traceId(b.project, ctx);
					await writeLineage(b.distro, trace, ctx);
					const r = await bridge(b.distro, ["cli", b.project, trace, "--", "status"]);
					show(format(r), r.code === 0);
				} else if (sub === "down") {
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, ["down", b.project]);
					show(format(r), r.code === 0);
				} else if (sub === "export") {
					if (rest.length !== 1) throw new Error("usage: /layerfs export <linux-dest-dir>");
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, ["export", b.project, rest[0]]);
					show(format(r), r.code === 0);
				} else if (sub === "rotate") {
					// a new project from main's files, then this folder is bound to it; the old one is kept
					if (rest.length > 1) throw new Error("usage: /layerfs rotate [new-project]");
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, ["rotate", b.project, b.image, ...rest]);
					const next = r.code === 0 ? /^new project: (\S+)$/m.exec(r.stdout)?.[1] : undefined;
					if (next) {
						const file = await rebind(ctx.cwd, next);
						show(
							`${format(r)}\nbound ${ctx.cwd} to LayerFS project ${next} (${file}), was ${b.project}. Once nothing needs ${b.project} any more: /layerfs remove ${b.project}`,
							true,
						);
					} else show(r.code === 0 ? `${format(r)}\nthe bridge named no new project; binding unchanged` : format(r), false);
				} else if (sub === "remove") {
					if (rest.length !== 1) throw new Error("usage: /layerfs remove <project> (its exact name)");
					const [project] = rest;
					// a folder without a binding may still remove a project of the default distro
					const bound = existsSync(bindingFile(ctx.cwd)) ? readBinding(ctx.cwd) : undefined;
					if (bound?.project === project)
						throw new Error(
							`${project} is the LayerFS project bound to this folder; rotate first (/layerfs rotate), then remove the old project`,
						);
					const r = await bridge(bound?.distro ?? DEFAULT_DISTRO, ["remove", project, project]);
					show(format(r), r.code === 0);
				} else if (sub === "projects") {
					// every project in the distro; works without a binding (default distro)
					if (rest.length) throw new Error("usage: /layerfs projects");
					const bound = existsSync(bindingFile(ctx.cwd)) ? readBinding(ctx.cwd) : undefined;
					const r = await bridge(bound?.distro ?? DEFAULT_DISTRO, ["projects"]);
					show(r.code === 0 && bound ? format({ ...r, stdout: markProject(r.stdout, bound.project) }) : format(r), r.code === 0);
				} else if (sub === "log") {
					const n = rest[0] === undefined ? 30 : Number(rest[0]);
					if (!Number.isInteger(n) || n < 1 || rest.length > 1) throw new Error("usage: /layerfs log [n]");
					const b = readBinding(ctx.cwd);
					const calls = await projectCalls(b);
					const shown = calls.slice(-n);
					show(
						calls.length === 0
							? `no traced LayerFS calls on project ${b.project}`
							: [
									`last ${shown.length} of ${calls.length} LayerFS calls on project ${b.project}:`,
									...shown.map(logLine),
								].join("\n"),
						true,
					);
				} else if (sub === "agents") {
					if (rest.length) throw new Error("usage: /layerfs agents");
					const b = readBinding(ctx.cwd);
					show(agentsReport(b.project, await projectCalls(b)), true);
				} else if (sub === "ui") {
					// the project's LayerFS page (ui/server.mjs in its client container), at http://localhost:<port>
					if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== "stop" && !/^\d{1,5}$/.test(rest[0])))
						throw new Error("usage: /layerfs ui [port] | ui stop");
					const b = readBinding(ctx.cwd);
					const r = await bridge(b.distro, rest[0] === "stop" ? ["ui-stop", b.project] : ["ui", b.project, ...rest]);
					show(format(r), r.code === 0);
				} else {
					throw new Error(USAGE);
				}
			} catch (e) {
				show(e instanceof Error ? e.message : String(e), false);
			}
		},
	});
}
