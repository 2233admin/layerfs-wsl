// The LayerFS Work/History page for one OMP project, without DeepSeek Harness.
// Runs in the project's client container (lfs-bridge.sh ui <project> [port]),
// which has the SDK's LAYERFS_* deployment, /root/layerfs read-only and the
// trace folder at its own path.
//
// The /layerfs routes are DSH's own handler (dsh/packages/host/src/route.js),
// registered through a stand-in for the DSH plugin context, over DSH's own
// Collector (collector.js: trace lines -> per-root view, authors of each node)
// and TreeReader (trees.js: inspect.snapshot / Store History / Files reads /
// storage through one SDK client). What DSH's runtime supplies is shimmed here:
//   - bindings: one project; every trace file <project>.<omp-session-id>.jsonl
//     is one agent, named by the session id's last characters, under one root
//     (the project's name), so /layerfs/session/<project> is all its agents;
//   - the SDK client (clientFor builds the deployment from DSH settings; the
//     container's environment already is the deployment);
//   - @deepseek-ai/dsh-session (records.js appends records to DSH sessions;
//     there are none here, the extension keeps OMP's own records);
//   - the docker CLI runtime.js runs for the Sandboxes tab and the runtime
//     overview: the client has the Docker socket, not the CLI, so those reads
//     are answered from the Engine API (see "docker"), and the home's container
//     prefix is the bridge's LAYERFS_CONTAINER_PREFIX (Sandboxes are
//     omp-lfs-<project>-<project>-<n>, not DSH's layerfs-<project>-<n>).
// The page (index.html, page.js) and DSH's view/model packages are served
// statically; the packages are imported unbuilt, as the DSH client does.
//
// usage: node server.mjs <project> [port]
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { registerHooks } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const LAYERFS = process.env.OMP_LFS_CHECKOUT || "/root/layerfs";
const ROOT = process.env.OMP_LFS_ROOT || "/root/omp-layerfs";
const DSH = join(LAYERFS, "dsh");
const HOST = join(DSH, "packages/host/src");
const UI = dirname(fileURLToPath(import.meta.url));
const TRACES = join(ROOT, "traces");
const POLL_MS = 1500;

const project = process.argv[2];
const port = Number(process.argv[3] || 8787);
if (!project || !/^[a-z0-9]([a-z0-9_.-]{0,61}[a-z0-9])?$/.test(project) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("usage: node server.mjs <project> [port]");
  process.exit(64);
}

// ------------------------------------------------------------------ docker
// runtime.js reads Docker with `docker -H unix://<socket> ...`; the client has the
// socket but no CLI. Its three reads are answered from the Engine API, as the CLI
// prints them for exactly the formats runtime.js asks for: this home's Sandbox
// containers, the engine's version and image names. Any other docker command fails
// as it does without the CLI (its writes are refused by requestRejection anyway);
// other programs run as they are.
const PS = ["ps", "-a", "--no-trunc", "--filter", "label=layerfs.role=sandbox", "--format", '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label "layerfs.project"}}\t{{.Label "layerfs.sandbox"}}\t{{.Image}}\t{{.Ports}}'];
const VERSION = ["version", "--format", "{{.Server.Version}}"];
const IMAGES = ["image", "inspect", "-f", '{{.Id}}\t{{join .RepoTags ","}}'];
const startsWith = (args, head) => head.every((a, i) => args[i] === a);
const lines = (rows) => rows.map((row) => `${row}\n`).join("");

/** One Engine API GET over the socket: [status, parsed body]. */
function engineGet(socketPath, path, timeout) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, timeout }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => {
        try { resolve([res.statusCode, JSON.parse(body)]); } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Docker did not answer ${path} within ${timeout} ms`)));
    req.on("error", reject).end();
  });
}

/** A container's published ports as `docker ps` prints them: `127.0.0.1:32795->30421/tcp, ...`. */
const portsOf = (ports = []) => [...new Set(ports.map((p) => (p.PublicPort ? `${p.IP?.includes(":") ? `[${p.IP}]` : p.IP}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)))].join(", ");

/** The stdout `docker <args>` would print, for the reads runtime.js makes. */
async function dockerRead(args, timeout) {
  const socket = args[0] === "-H" ? /^unix:\/\/(.+)$/.exec(args[1] ?? "")?.[1] : null, cmd = args.slice(2);
  const get = async (path, missingOk = false) => {
    const [status, body] = await engineGet(socket, path, timeout);
    if (status === 200 || (missingOk && status === 404)) return [status, body];
    throw new Error(body?.message ?? `Docker answered ${status} to ${path}`);
  };
  if (socket && cmd.length === PS.length && startsWith(cmd, PS)) {
    const [, list] = await get(`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ["layerfs.role=sandbox"] }))}`);
    return lines(list.map((c) => [
      c.Names.map((n) => n.slice(1)).filter((n) => !n.includes("/")).join(","), c.State, c.Status,
      c.Labels?.["layerfs.project"] ?? "", c.Labels?.["layerfs.sandbox"] ?? "", c.Image, portsOf(c.Ports),
    ].join("\t")));
  }
  if (socket && cmd.length === VERSION.length && startsWith(cmd, VERSION)) return lines([(await get("/version"))[1].Version]);
  if (socket && cmd.length > IMAGES.length && startsWith(cmd, IMAGES)) {
    const ids = cmd.slice(IMAGES.length), found = await Promise.all(ids.map((id) => get(`/images/${encodeURIComponent(id)}/json`, true)));
    const stdout = lines(found.filter(([status]) => status === 200).map(([, image]) => `${image.Id}\t${(image.RepoTags ?? []).join(",")}`));
    const missing = ids.filter((_, i) => found[i][0] === 404);
    // as the CLI: the found images on stdout, and a failure for the missing ones
    if (missing.length) throw Object.assign(new Error(`No such image: ${missing.join(", ")}`), { stdout, stderr: lines(missing.map((id) => `Error response from daemon: No such image: ${id}`)) });
    return stdout;
  }
  throw Object.assign(new Error(`spawn docker ENOENT: this client has no docker CLI; docker ${cmd.join(" ")} is not answered from its socket`), { code: "ENOENT" });
}

/** child_process.execFile for runtime.js: `docker` reads from dockerRead, everything else as it is. */
function runtimeExecFile(file, ...rest) {
  if (file !== "docker") return execFile(file, ...rest);
  const [args, options, callback] = typeof rest[1] === "function" ? [rest[0], undefined, rest[1]] : rest;
  dockerRead(args ?? [], options?.timeout).then((stdout) => callback?.(null, stdout, ""), (error) => callback?.(error, error.stdout ?? "", error.stderr ?? ""));
}
runtimeExecFile[promisify.custom] = (file, ...rest) => (file === "docker"
  ? dockerRead(rest[0] ?? [], rest[1]?.timeout).then((stdout) => ({ stdout, stderr: "" }))
  : promisify(execFile)(file, ...rest));
globalThis[Symbol.for("omp-lfs.runtimeExecFile")] = runtimeExecFile;
const RUNTIME = pathToFileURL(join(HOST, "runtime.js")).href;
const CHILD_PROCESS_SHIM = `data:text/javascript,${encodeURIComponent('export * from "node:child_process"; export const execFile = globalThis[Symbol.for("omp-lfs.runtimeExecFile")];')}`;

// The host modules import their workspace packages by name; there is no
// node_modules in the checkout, so the names resolve to the checkout's files.
const SESSION_SHIM = "data:text/javascript,export function appendPluginRecord() {}";
const NAMES = [
  [/^@dsh-layerfs\/model$/, () => join(DSH, "packages/model/src/index.js")],
  [/^@dsh-layerfs\/model\/(.+)$/, (m) => join(DSH, "packages/model/src", m[1])],
  [/^@layerfs\/sdk$/, () => join(LAYERFS, "sdk/js/src/index.js")],
  [/^@layerfs\/sdk\/operator$/, () => join(LAYERFS, "sdk/js/operator/index.js")],
];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@deepseek-ai/dsh-session") return { url: SESSION_SHIM, shortCircuit: true };
    if (specifier === "node:child_process" && context.parentURL === RUNTIME) return { url: CHILD_PROCESS_SHIM, shortCircuit: true };
    for (const [re, path] of NAMES) {
      const m = re.exec(specifier);
      if (m) return { url: pathToFileURL(path(m)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const hostModule = (name) => import(pathToFileURL(join(HOST, name)).href);
const [{ registerRoutes }, { Collector }, { TreeReader }] = await Promise.all([hostModule("route.js"), hostModule("collector.js"), hostModule("trees.js")]);

// ------------------------------------------------------------------ bindings
const PROJECT = { name: project, source: null, volume: process.env.LAYERFS_VOLUME ?? null, created: 0 };
/** trace id (<project>.<session>) -> { root, name } */
const agents = new Map();
const traceIdOf = (file) => {
  if (!file.startsWith(`${project}.`) || !file.endsWith(".jsonl")) return null;
  const session = file.slice(project.length + 1, -6);
  return session && !session.includes(".") ? `${project}.${session}` : null;
};
/** An agent's name: its session id's tail, longer while another agent has it. */
function nameOf(id) {
  const session = id.slice(project.length + 1), taken = new Set([...agents.values()].map((a) => a.name));
  for (let k = 4; k < session.length; k += 2) if (!taken.has(session.slice(-k))) return session.slice(-k);
  return session;
}
const bindings = {
  agent: (id) => agents.get(id) ?? null,
  agentsOf: (root) => Object.fromEntries([...agents].filter(([, a]) => a.root === root).map(([id, a]) => [id, a.name])),
  setAgent() {},
  session: (root) => (root === project ? { project, locked: true, folder: null } : null),
  projectFor: (root) => (root === project ? PROJECT : null),
  workspace: () => ({ projects: [PROJECT], lastUsed: project }),
  byName: (name) => (name === project ? PROJECT : null),
  projects: () => [PROJECT],
  defaults: () => ({}),
};

// ------------------------------------------------------------------ collector
// Its line journal is rebuilt from the trace files at every start.
const stateDir = `/tmp/omp-lfs-ui-${project}`;
rmSync(stateDir, { recursive: true, force: true });
const spec = {
  traceDir: TRACES, stateDir, pollMs: POLL_MS,
  sdk: pathToFileURL(join(LAYERFS, "sdk/js/src/index.js")).href,
  operator: pathToFileURL(join(LAYERFS, "sdk/js/operator/index.js")).href,
  home: process.env.LAYERFS_HOME, docker: process.env.LAYERFS_DOCKER, image: process.env.LAYERFS_IMAGE, daemon: process.env.LAYERFS_DAEMON,
  // runtime.js lists this home's Sandbox containers by it (the bridge sets it per client)
  prefix: process.env.LAYERFS_CONTAINER_PREFIX || `omp-lfs-${project}-`,
};
const ctx = {
  sessions: new Map(), // no DSH sessions: nothing is appended to one
  logger: { warn: (m) => console.error(m) },
  connection: { requestRejection },
  webServer: { register: (r) => { route = r.handler; return () => {}; } },
  effect: (fn) => fn(),
};
const collector = new Collector(ctx, spec, bindings);

/** Follows every trace file of the project from its start (DSH's track starts at the end: its journal has the past). */
function collect() {
  if (existsSync(TRACES)) for (const file of readdirSync(TRACES)) {
    const id = traceIdOf(file);
    if (!id || agents.has(id)) continue;
    agents.set(id, { root: project, name: nameOf(id) });
    collector.tails.set(id, { file: join(TRACES, file), offset: 0, rest: "", project });
  }
  collector.poll();
  collector.pending.clear(); // records for DSH sessions, of which there are none
}

// ------------------------------------------------------------------ SDK client
// clientFor without DSH's deployment settings: the container's environment is the deployment.
async function openClient() {
  const [{ LayerFS }, { LayerFSOperator }, { invokeOperator }] = await Promise.all([
    import(spec.sdk), import(spec.operator), import(pathToFileURL(join(LAYERFS, "sdk/js/src/client.js")).href),
  ]);
  const layerfs = new LayerFS(project);
  const history = async () => {
    await layerfs.store();
    return invokeOperator("operator.inspect.history", { project: layerfs.projectName, home: layerfs.options.home, storePath: layerfs.options.storePath }, layerfs.options);
  };
  return { layerfs, operator: new LayerFSOperator(layerfs), history };
}
const trees = new TreeReader(spec, openClient);

// ------------------------------------------------------------------ routes
let route = null;
/**
 * DSH's Connection checks, for a page without sign-in: only a localhost Host (DNS
 * rebinding), and only reads. The handler's writes (Init, project removal, Sandbox
 * actions) are refused, so no other site's page can make them through a viewer's browser.
 */
function requestRejection(req) {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return 403;
  return req.method === "GET" || req.method === "HEAD" ? undefined : 405;
}
registerRoutes(ctx, { spec, bindings, collector, trees });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
/** Statically served: the page, and DSH's view and model packages and the simulator's file helpers they draw with. */
const STATIC = [
  ["/dsh/packages/view/", join(DSH, "packages/view/")],
  ["/dsh/packages/model/", join(DSH, "packages/model/")],
  ["/dsh/sim/simulation_engine/", join(DSH, "sim/simulation_engine/")],
  ["/", `${UI}${sep}`],
];
function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const file = resolve(dir, `.${sep}${decodeURIComponent(pathname.slice(prefix.length)) || "index.html"}`);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile() || file === join(UI, "server.mjs")) break;
    res.writeHead(200, { "content-type": `${TYPES[extname(file)] ?? "application/octet-stream"}; charset=utf-8`, "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

collect();
setInterval(() => { try { collect(); } catch (e) { console.error(`trace collection failed: ${e.message}`); } }, POLL_MS).unref();

const server = createServer((req, res) => {
  const pathname = new URL(String(req.url), "http://localhost").pathname;
  if (pathname === "/layerfs" || pathname.startsWith("/layerfs/")) return route(req, res);
  const rejection = requestRejection(req);
  if (rejection !== undefined) { res.statusCode = rejection; return res.end(); }
  serveStatic(req, res, pathname);
});
server.listen(port, "127.0.0.1", () => console.log(`LayerFS page of project ${project}: http://localhost:${port}`));
const stop = () => { server.close(() => trees.dispose().finally(() => process.exit(0))); server.closeAllConnections(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
