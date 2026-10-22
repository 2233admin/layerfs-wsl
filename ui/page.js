// The page's glue around DSH's LayerFS view (@dsh-layerfs/view), as the DSH
// client plugin's LayerFS tab does it (dsh/packages/client/src/client):
// the project's whole History from the Store seeds a replay engine, and every
// agent's SDK calls (the trace lines the server collects) are played on top,
// each a moment after it ended. seedEngine/attribute/chronological are
// replay.ts, Playback is playback.ts and storeOf is storage.ts, in plain JS;
// Board below is LayerFsView.tsx's Board without React, and the Sandboxes view
// beside its Work | History switch is SandboxesTab.tsx (with runtimeParts.tsx).
import { createFilesSource, createView, heroAvatars, injectStyle } from "/dsh/packages/view/src/index.js";
import * as X from "/dsh/packages/model/src/index.js";

const FM = globalThis.LayerFiles, M = globalThis.LayerSim; // the simulator's UMD helpers (index.html)
const POLL_MS = 1500, STORE_MS = 10_000, LAG_MS = 2000;

/** GET /layerfs<path>, or POST it `body` as JSON. */
async function call(path, body) {
  const init = body === undefined ? { cache: "no-store" } : { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`/layerfs${path}`, init);
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.message || `HTTP ${res.status}`);
  return answer;
}
const P = (name) => `/project/${encodeURIComponent(name)}`;
const filesQuery = (query) => new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();

// ---------------------------------------------------------------- replay.ts
function seedEngine(engine, state, { workspaces = true } = {}) {
  const m = engine.m;
  m.s = { ...structuredClone(state.s), roots: {}, ...(workspaces ? {} : { sandboxes: {}, sandboxOrder: [] }) };
  for (const [real, label] of Object.entries(state.labels)) {
    m.toLabel.set(real, label); m.toReal.set(label, real);
    const n = /^([CLR])(\d+)$/.exec(label);
    if (n) m.next[n[1]] = Math.max(m.next[n[1]], Number(n[2]) + 1);
  }
  for (const node of [...Object.values(m.s.commits), ...Object.values(m.s.layers)]) node.root = node.id;
  chronological(m.s, state);
  const slots = [...Object.values(m.s.commits), ...Object.values(m.s.layers), ...Object.values(m.s.branches)].map((x) => x.slot ?? 0);
  m.slot = Math.max(m.slot, ...slots, -1) + 1;
  engine.seeded = true;
}

function attribute(W, state) {
  for (const [real, agent] of Object.entries(state.authors ?? {})) {
    const label = state.labels[real];
    if (label) W.attrib[label] = agent;
  }
  return W;
}

function chronological(s, state) {
  const at = new Map();
  for (const c of Object.values(s.commits)) at.set(c.id, c.time);
  const realOf = new Map(Object.entries(state.labels).map(([r, label]) => [label, r]));
  const layers = Object.values(s.layers).sort((a, b) => a.slot - b.slot);
  for (const l of layers) {
    const after = Math.max(at.get(l.parent) ?? -Infinity, at.get(l.sourceCommit) ?? -Infinity);
    const known = state.times[realOf.get(l.id) ?? ""];
    at.set(l.id, known ?? (after === -Infinity ? 0 : after + 1));
  }
  for (const b of s.branchOrder.map((name) => s.branches[name])) {
    const first = Math.min(...Object.values(s.commits).filter((c) => c.branch === b.name).map((c) => c.time));
    const after = (at.get(b.from) ?? 0) + 0.5;
    at.set(`fork:${b.name}`, Math.min(state.forks[b.name] ?? after, first - 0.5));
  }
  const rank = (id) => (id.startsWith("fork:") ? 0 : s.commits[id] ? 1 : 2);
  const order = [...at.keys()].sort((x, y) => at.get(x) - at.get(y) || rank(x) - rank(y));
  order.forEach((id, slot) => {
    if (id.startsWith("fork:")) s.branches[id.slice(5)].slot = slot;
    else (s.commits[id] ?? s.layers[id]).slot = slot;
  });
}

// ---------------------------------------------------------------- playback.ts
const rides = (method) => method === "sandbox.service" || (method.startsWith("operator.") && method !== "operator.process.start" && method !== "operator.process.cancel");
const dueOf = (line) => Date.parse(line.start) + (line.ms || 0) + LAG_MS;

class Playback {
  constructor(fresh, show, now = Date.now) {
    this.show = show; this.now = now; this.W = fresh();
    this.seen = new Set(); this.pending = []; this.queue = []; this.t0 = null;
    this.running = false; this.stopped = false; this.wake = null; this.feeding = Promise.resolve(); this.played = 0;
  }
  get waiting() { return this.queue.length; }
  feed(lines, agent) {
    const next = this.feeding.then(() => this.take(lines, agent));
    this.feeding = next.catch(() => {});
    return next;
  }
  async take(lines, agent) {
    const ends = X.endLines(lines);
    if (!ends.length) return;
    this.t0 ??= Date.parse(ends[0].start);
    const t0 = this.t0;
    for (const line of ends) {
      if (this.seen.has(line.id)) continue;
      this.seen.add(line.id);
      this.pending.push(line);
      if (rides(line.method)) continue;
      const batch = this.pending;
      this.pending = [];
      const due = Math.max(Math.min(dueOf(line), this.now() + LAG_MS), this.queue.length ? this.queue[this.queue.length - 1].due : 0);
      this.queue.push({ a: line.agent || agent, line, due, replay: (W) => { for (const l of batch) X.replayLine(W, l, { agent, t0 }); } });
    }
    this.wake?.();
    await this.play();
  }
  stop() { this.stopped = true; this.queue = []; this.wake?.(); }
  async play() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        await this.until(this.queue[0].due);
        if (this.stopped) return;
        const now = this.now();
        let last = null;
        while (this.queue.length && this.queue[0].due <= now) {
          last = this.queue.shift();
          await X.runStep(this.W, last, {});
          this.played++;
        }
        if (last) this.show(this.W, now - last.due < LAG_MS ? last : null);
      }
    } finally {
      this.running = false;
    }
  }
  async until(due) {
    const left = due - this.now();
    if (left <= 0) return;
    await new Promise((resolve) => { const timer = setTimeout(resolve, left); this.wake = () => { clearTimeout(timer); resolve(); }; });
    this.wake = null;
  }
}

// ---------------------------------------------------------------- storage.ts
function storeOf(storage, state, lines = []) {
  const z = storage.store, s = state.s;
  const realOf = (label) => (label ? Object.keys(state.labels).find((real) => state.labels[real] === label) ?? null : null);
  const layer = s.layers?.[s.main?.head], source = realOf(layer?.sourceCommit);
  const made = new Map();
  for (const line of lines) {
    if (!line.ok || line.phase === "start") continue;
    if (line.commit && line.sizes) made.set(line.commit, line.sizes.logical ?? null);
    else if (line.method === "branch.merge" && line.head && !made.has(line.head)) made.set(line.head, null);
  }
  const commits = new Set([...Object.keys(state.labels).filter((real) => /^C\d+$/.test(state.labels[real])), ...made.keys()]);
  const head = layer?.logical ?? (source ? storage.commits.find((c) => c.id === source)?.logical ?? made.get(source) ?? null : s.main?.head === "L0" && layer ? storage.init?.bytes ?? null : null);
  return {
    logical: z.logical, payload: z.canonical, stored: z.stored, metadata: z.metadata, store: z.file, estimate: false,
    head, baseline: storage.init ? storage.init.metadata + storage.init.stored : null, imported: storage.init?.files ?? 0,
    counts: { commits: commits.size, branches: Object.keys(s.branches ?? {}).length, layers: Object.keys(s.layers ?? {}).length },
    perCommit: storage.commits.slice().reverse().map((c) => ({ via: c.via, bytes: c.newStored + c.newMetadata, label: state.labels[c.id] ?? null, message: c.message })),
  };
}

// ---------------------------------------------------------------- SandboxesTab.tsx
// A project's Sandboxes: each running Sandbox (lfsb-<project>-<project>-<n>)
// with how full it is, and each Workspace in it with its Branch, the agent that
// mounted it, how long it has sat, its uncommitted changes and background
// processes. LayerFS starts and closes Sandboxes by itself; the actions here end
// one Workspace or process (POST .../runtime). One that would cut off an agent's
// call running in that Workspace is disabled; one that loses work asks first.
// A third button on the view's Work | History switch shows it in their place.
const SBX_MS = 10_000; // runtimeParts.tsx POLL_MS: each read asks the Sandboxes' daemons
const LEVEL_WORD = { ok: "ok", degraded: "needs a look", down: "down" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** 40 s, 12 min, 3 h, 2 d. */
function span(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
/** `/workspaces/3` → "WS 3", as the views name a Workspace. */
const wsName = (path) => `WS ${path.slice(path.lastIndexOf("/") + 1)}`;
/** A Sandbox's image as shown: its tag, else the digest's first 12 hex digits. */
const imageLabel = (s) => s.imageName ?? (s.image ? s.image.replace(/^sha256:/, "").slice(0, 12) : null);
const dot = (level, title = LEVEL_WORD[level]) => `<span class="sbx-dot ${level}" role="img" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
const meter = (used, capacity) => `<span class="sbx-meter${used >= capacity ? " full" : ""}" title="${used} of ${capacity} Workspaces"><span style="width:${Math.min(1, used / capacity) * 100}%"></span></span>`;
const chip = (text, tone = "") => `<span class="sbx-chip ${tone}">${esc(text)}</span>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One Workspace row: its Branch, agent, idle time, changes, processes, actions and the open question. */
function workspaceRow(sb, w, disabled, ask) {
  const why = w.busy ? `An agent's call is running in ${wsName(w.path)}; wait for it to end` : null;
  const at = `data-sandbox="${esc(sb.id)}" data-path="${esc(w.path)}"`;
  const off = disabled || w.busy ? " disabled" : "";
  const sat = w.busy ? "in use now" : w.idleMs !== null ? `idle ${span(w.idleMs)}` : (w.activity ?? "").toLowerCase() || "mounted";
  const action = w.uncommitted
    ? `<button class="outline" data-act="discard" ${at}${off} title="${esc(why ?? "Drop its uncommitted changes and unmount it")}">Discard…</button>`
    : `<button class="outline" data-act="unmount" ${at}${off} title="${esc(why ?? "Unmount it: nothing is uncommitted")}">Unmount</button>`;
  const processes = w.processes.map((p) => `<div class="sbx-proc"><code title="${esc(p.command)}">${esc(p.command)}</code><span>· ${esc(p.status)}</span><span class="grow"></span>`
    + `<button class="ghost" data-act="stop" ${at} data-process="${esc(p.id)}" data-command="${esc(p.command)}"${disabled ? " disabled" : ""}>Stop…</button></div>`).join("");
  const question = !ask ? "" : `<div class="sbx-ask" role="alertdialog"><span>${ask.kind === "discard"
    ? `Drop ${plural(w.uncommitted, "uncommitted change")} in ${esc(wsName(w.path))} (${esc(w.branch ?? "")}${w.agent ? `, ${esc(w.agent)}` : ""}) and unmount it? This can't be undone.`
    : `Stop <code>${esc(ask.command)}</code> in ${esc(wsName(w.path))}${w.agent ? `, started by ${esc(w.agent)}` : ""}?`}</span>`
    + `<button class="primary" data-act="confirm"${disabled ? " disabled" : ""}>${ask.kind === "discard" ? "Discard" : "Stop"}</button><button class="ghost" data-act="cancel">Cancel</button></div>`;
  return `<div class="sbx-ws"><div class="sbx-row">${w.busy ? dot("ok", "in use") : dot(w.level)}<b class="sbx-wsname">${esc(wsName(w.path))}</b>`
    + `<span class="mono">${esc(w.branch ?? "—")}</span>${w.agent ? `<span class="dim">· ${esc(w.agent)}</span>` : ""}<span class="dim">· ${esc(sat)}</span>`
    + (w.uncommitted ? chip(`${w.uncommitted} uncommitted`, w.level === "ok" ? "" : "warn") : chip("clean", "ok"))
    + (w.stale ? chip("Branch moved since mount") : "") + `<span class="grow"></span>${action}</div>${processes}${question}</div>`;
}

/**
 * The Sandboxes view in `root` (the view's own root, for its tokens), opened
 * by a Sandboxes button after the view's Work | History buttons; picking Work
 * or History closes it. `open` opens it at once (?pane=sandboxes).
 */
function sandboxesView(root, name, open) {
  const swap = root.querySelector(".lfs-swap");
  const panel = document.createElement("div");
  panel.className = "lfs-sbx lfs-own"; // lfs-own: the view's button reset leaves its controls alone
  panel.hidden = true;
  root.append(panel);
  let runtime = null, error = null, busy = null, failed = null, ask = null, seq = 0, drawn = "";

  function draw() {
    const sandboxes = runtime?.sandboxes ?? [], workspaces = sandboxes.reduce((n, s) => n + s.workspaces.length, 0);
    const disabled = !!busy || !!runtime?.pending;
    const status = runtime ? `${plural(sandboxes.length, "Sandbox", "Sandboxes")} · ${plural(workspaces, "Workspace")} · up to ${sandboxes[0]?.capacity ?? 16} each` : error ? "Sandboxes not read" : "Reading Sandboxes…";
    const cards = sandboxes.map((sb) => {
      const label = sb.name ?? `Sandbox ${sb.id}`, image = imageLabel(sb);
      return `<section class="sbx-card" aria-label="${esc(label)}"><header>${dot(sb.level)}<b class="mono">${esc(label)}</b>`
        + `<span class="dim">${sb.workspaces.length ? "running" : "idle · closes by itself"}</span>`
        + (image ? `<span class="dim mono small" title="${esc(sb.image)}">image ${esc(image)}</span>` : "")
        + `<span class="grow"></span><span class="dim">${sb.workspaces.length}/${sb.capacity}</span>${meter(sb.workspaces.length, sb.capacity)}</header>`
        + sb.workspaces.map((w) => workspaceRow(sb, w, disabled, ask && ask.sandbox === sb.id && ask.path === w.path ? ask : null)).join("") + "</section>";
    }).join("");
    const html = `<div class="sbx"><div class="sbx-head">${runtime ? dot(runtime.level) : ""}<span>${esc(status)}</span>`
      + (runtime?.simulated ? `<span class="cap">· simulated</span>` : "")
      + `<span class="grow"></span><button class="ghost" data-act="refresh"${busy ? " disabled" : ""}>Refresh</button></div><div class="sbx-body">`
      + (error || failed ? `<div class="bad" role="status">${esc(failed ?? error)}</div>` : "")
      + (busy ? `<div class="dim" role="status">${esc(busy)}</div>` : "")
      + (runtime?.pending ? `<div class="dim" role="status">Still reading the Sandboxes' Workspaces; shown meanwhile from Docker and the agents' calls, without changes, Branches or processes.</div>` : "")
      + (runtime && !sandboxes.length ? `<div class="dim">No Sandbox runs. LayerFS starts one when an agent mounts a Workspace and closes it once it sits idle; reading this page starts none.</div>` : "")
      + cards
      + (runtime?.gone ?? []).map((g) => `<div class="sbx-card sbx-gone">${dot("degraded")} ${esc(g.name ?? `Sandbox ${g.id}`)}: its container is gone; LayerFS closes it on the next read.</div>`).join("")
      + "</div></div>";
    if (html !== drawn) panel.innerHTML = drawn = html;
  }

  /** Reads the project's Sandboxes; only the latest read started is drawn. */
  async function read() {
    const n = ++seq;
    try { const next = await call(`${P(name)}/runtime`); if (n === seq) { runtime = next; error = null; } } catch (e) { if (n === seq) error = e.message; }
    if (n === seq) draw();
  }
  async function act(label, body) {
    busy = label; failed = null; draw();
    try { await call(`${P(name)}/runtime`, body); ask = null; read(); } catch (e) { failed = e.message; } finally { busy = null; draw(); }
  }

  // the view rewrites its switch at every render: the Sandboxes button goes back after its two,
  // and while the Sandboxes are shown neither of them is the picked one
  function mark() {
    let button = swap.querySelector("button[data-sbx]");
    if (!button) { swap.insertAdjacentHTML("beforeend", `<button role="tab" data-sbx="1">Sandboxes</button>`); button = swap.lastElementChild; }
    if (open) for (const b of swap.querySelectorAll("button[data-swap]")) { b.classList.remove("on"); b.setAttribute("aria-selected", "false"); }
    button.classList.toggle("on", open);
    button.setAttribute("aria-selected", String(open));
  }
  function show(on) {
    open = on;
    root.classList.toggle("sbx-on", on);
    panel.hidden = !on;
    mark();
    const url = new URL(location.href);
    if (on) url.searchParams.set("pane", "sandboxes"); else if (url.searchParams.get("pane") === "sandboxes") url.searchParams.delete("pane");
    history.replaceState(history.state, "", url);
    if (on) { draw(); read(); }
  }
  swap.setAttribute("aria-label", "Work, History or Sandboxes");
  new MutationObserver(mark).observe(swap, { childList: true });
  // before the view's own click handling: Sandboxes is not one of its panes; Work or History closes this
  root.addEventListener("click", (e) => {
    if (e.target.closest(".lfs-swap button[data-sbx]")) { e.stopPropagation(); if (!open) show(true); return; }
    if (open && e.target.closest(".lfs-swap button[data-swap]")) show(false);
  }, true);
  panel.addEventListener("click", (e) => {
    e.stopPropagation(); // nothing of the view's in here
    const el = e.target.closest("button[data-act]");
    if (!el || el.disabled) return;
    const { act: what, sandbox, path, process, command } = el.dataset;
    if (what === "refresh") read();
    else if (what === "unmount") act(`Unmounting ${wsName(path)}…`, { action: "unmount", sandbox, path });
    else if (what === "discard") { ask = { kind: "discard", sandbox, path }; draw(); }
    else if (what === "stop") { ask = { kind: "stop", sandbox, path, process, command }; draw(); }
    else if (what === "cancel") { ask = null; draw(); }
    else if (what === "confirm" && ask) {
      if (ask.kind === "discard") act(`Discarding ${wsName(ask.path)}…`, { action: "discard", sandbox: ask.sandbox, path: ask.path, confirm: ask.path });
      else act("Stopping the process…", { action: "stop", process: ask.process });
    }
  });
  // runtimeParts.tsx usePoll: now, every SBX_MS while shown and the page is visible, and when it comes back
  setInterval(() => { if (open && document.visibilityState === "visible") read(); }, SBX_MS);
  document.addEventListener("visibilitychange", () => { if (open && document.visibilityState === "visible") read(); });
  show(open);
}

/**
 * The project switcher after the LayerFS mark: every project page the bridge started
 * (server.mjs /bridge/projects, from its ui-ports file). Each project's page is its own
 * server on its own port, so picking one opens that port with the same ?pane.
 */
function projectSwitcher(root, name) {
  const el = document.createElement("label");
  el.className = "lfs-proj lfs-own";
  el.innerHTML = `<span class="lfs-proj-k">Project</span><select aria-label="LayerFS project"></select>`;
  const select = el.querySelector("select");
  let pages = [{ project: name, port: Number(location.port) || 80, running: true }], drawn = "";
  const place = () => { const logo = root.querySelector(".lfs-strip > .lfs-logo"); if (logo && logo.nextElementSibling !== el) logo.after(el); };
  function draw() {
    const html = pages.map((p) => `<option value="${esc(p.project)}"${p.project === name ? " selected" : ""}${p.running || p.project === name ? "" : " disabled"}>`
      + `${esc(p.project)} · :${p.port}${p.running || p.project === name ? "" : " · stopped"}</option>`).join("");
    if (html !== drawn) select.innerHTML = drawn = html;
    el.title = pages.some((p) => !p.running) ? "A stopped project's page starts again with /layerfs ui in its folder" : "";
  }
  async function read() {
    try { const res = await fetch("/bridge/projects", { cache: "no-store" }); if (res.ok) pages = (await res.json()).projects; } catch { /* keep the last list */ }
    draw();
  }
  select.addEventListener("change", () => {
    const page = pages.find((p) => p.project === select.value);
    if (!page || page.project === name) return;
    location.href = `${location.protocol}//${location.hostname}:${page.port}/${location.search}`;
  });
  el.addEventListener("click", (e) => e.stopPropagation()); // nothing of the view's in here
  place();
  new MutationObserver(place).observe(root, { childList: true, subtree: false });
  draw();
  read();
  setInterval(() => { if (document.visibilityState === "visible") read(); }, 10_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") read(); });
}

/**
 * The light/dark switch at the strip's end. index.html set the theme on <html> before the view
 * drew: the viewer's last pick, else the system's. A pick is kept in the cookie "lfs-theme" (a
 * cookie ignores the port, so every project's page shares it; localStorage would be one per port);
 * with none kept the page follows the system as it changes.
 */
function themeSwitch(root) {
  const html = document.documentElement, sys = matchMedia("(prefers-color-scheme: dark)");
  const kept = () => /(?:^|; )lfs-theme=(dark|light)/.exec(document.cookie)?.[1];
  const SUN = `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="2.6"/><path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13M2.8 2.8l1.1 1.1M10.1 10.1l1.1 1.1M2.8 11.2l1.1-1.1M10.1 3.9l1.1-1.1"/></svg>`;
  const MOON = `<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4Z"/></svg>`;
  const el = document.createElement("button");
  el.className = "lfs-theme lfs-own";
  el.type = "button";
  const draw = () => {
    const dark = html.dataset.theme === "dark";
    el.innerHTML = dark ? SUN : MOON; // the icon shows what a click turns to
    el.title = dark ? "Light" : "Dark";
    el.setAttribute("aria-label", dark ? "Switch to light" : "Switch to dark");
  };
  const set = (theme) => { html.dataset.theme = theme; draw(); };
  el.addEventListener("click", (e) => {
    e.stopPropagation(); // nothing of the view's in here
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    document.cookie = `lfs-theme=${next}; path=/; max-age=31536000; SameSite=Lax`;
    set(next);
  });
  sys.addEventListener("change", (e) => { if (!kept()) set(e.matches ? "dark" : "light"); });
  const place = () => { const strip = root.querySelector(".lfs-strip"); if (strip && strip.lastElementChild !== el) strip.append(el); };
  draw();
  place();
  new MutationObserver(place).observe(root, { childList: true, subtree: false });
}

// ---------------------------------------------------------------- the board
const message = document.getElementById("message");
const say = (text) => { message.textContent = text; message.hidden = !text; };

async function main() {
  const { projects } = await call("/projects");
  const name = projects[0].name;
  document.title = `LayerFS · ${name}`;
  say(`Loading ${name}'s History…`);
  // the project's whole History first (a Host without the History-only read answers the full state read)
  const seed = await call(`${P(name)}/history`).catch(() => call(`${P(name)}/state`)).catch((e) => { say(`${name}'s History could not be read: ${e.message}`); return null; });

  injectStyle(document);
  // ?pane=work|history opens that side of the view's Work | History switch (its per-viewer preference);
  // ?pane=sandboxes opens the Sandboxes view beside them
  const pane = new URLSearchParams(location.search).get("pane");
  if (pane === "work" || pane === "history") {
    try { localStorage.setItem("lfs-layout", JSON.stringify({ ...JSON.parse(localStorage.getItem("lfs-layout") || "{}"), pane })); } catch { /* not kept */ }
  }
  const root = document.getElementById("lfs");
  const b = createView(root, { avatars: heroAvatars((k) => `/dsh/packages/view/src/skins/heroes/images/${k}.png`), files: FM, lineDiff: M.lineDiff, live: false, lead: "main" });
  sandboxesView(root, name, pane === "sandboxes");
  projectSwitcher(root, name);
  themeSwitch(root);
  let soon;
  b.rerender = () => { clearTimeout(soon); soon = setTimeout(() => b.W && b.render(), 40); };
  const files = createFilesSource((kind, query) => call(`${P(name)}/${kind}?${filesQuery(query)}`), () => b.rerender());

  let view = null, play = null, store = null, storeRead = 0, lastState = seed;
  const runningAgents = (v) => v.running.map((line) => v.agents[line.agentId] ?? line.agent);
  const noteOf = (v, playback) => `${name} · ${v.lines.length} calls · ${Object.keys(v.agents).length} agents`
    + (playback.waiting ? ` · ${playback.waiting} to play` : "") + (v.running.length ? ` · ${v.running.length} running` : "");

  function show(W, step, playback) {
    b.avatar("main");
    if (step) b.avatar(step.a);
    else for (const line of view.lines) b.avatar(view.agents[line.agentId] ?? line.agent);
    b.W = W;
    if (step) { b.acting = [step.a]; b.lastLoc = X.locKey(X.where(W, step.a)); } else b.acting = runningAgents(view);
    if (b.follow && W.lastTab) b.active = W.lastTab;
    b.note = noteOf(view, playback);
    b.render();
    if (step) b.animate(step.a);
    say("");
  }

  function readStore() {
    if (Date.now() - storeRead < STORE_MS) return;
    storeRead = Date.now();
    Promise.allSettled([call(`${P(name)}/storage`), call(`${P(name)}/state`)]).then(([storage, state]) => {
      if (state.status === "fulfilled") lastState = state.value;
      if (storage.status !== "fulfilled" || !storage.value.store || !lastState) return;
      store = storeOf(storage.value, lastState, view?.lines ?? []);
      b.rerender();
    });
  }

  function take(next) {
    const grew = !view || next.lines.length !== view.lines.length;
    view = next;
    if (grew) readStore();
    const agents = Object.values(view.agents).join(",");
    if (!play || play.agents !== agents) {
      // a rebuild (an agent appeared): what is past applies at once, so nothing plays twice
      play?.playback.stop();
      const fresh = () => {
        const engine = new X.ReplayEngine({ project: name, files });
        engine.onchange = () => b.rerender();
        engine.storage = () => store;
        // the project's history first; Workspaces come from the calls
        if (seed) seedEngine(engine, seed, { workspaces: false });
        const W = X.storyView(engine, { lead: "main" });
        return seed ? attribute(W, seed) : W;
      };
      const playback = new Playback(fresh, (W, step) => show(W, step, playback));
      play = { playback, agents };
    }
    const lines = [...view.lines].sort((x, y) => Date.parse(x.start) - Date.parse(y.start)).map((line) => ({ ...line, agent: view.agents[line.agentId] ?? line.agent }));
    const playback = play.playback;
    playback.feed(lines, "main").catch((e) => { b.note = `The calls could not be replayed: ${e.message}`; });
    if (!lines.length && !b.W) show(playback.W, null, playback); // no calls yet: the History alone
    else if (!playback.waiting && b.W) { b.acting = runningAgents(view); b.note = noteOf(view, playback); b.render(); }
  }

  const poll = async () => {
    try { take(await call(`/session/${encodeURIComponent(name)}`)); } catch (e) { if (b.W) { b.note = `LayerFS is not answering: ${e.message}`; b.render(); } else say(`LayerFS is not answering: ${e.message}`); }
    setTimeout(poll, POLL_MS);
  };
  await poll();
}

main().catch((e) => say(`The page could not start: ${e.message}`));
