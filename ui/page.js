// The page's glue around DSH's LayerFS view (@dsh-layerfs/view), as the DSH
// client plugin's LayerFS tab does it (dsh/packages/client/src/client):
// the project's whole History from the Store seeds a replay engine, and every
// agent's SDK calls (the trace lines the server collects) are played on top,
// each a moment after it ended. seedEngine/attribute/chronological are
// replay.ts, Playback is playback.ts and storeOf is storage.ts, in plain JS;
// Board below is LayerFsView.tsx's Board without React.
import { createFilesSource, createView, heroAvatars, injectStyle } from "/dsh/packages/view/src/index.js";
import * as X from "/dsh/packages/model/src/index.js";

const FM = globalThis.LayerFiles, M = globalThis.LayerSim; // the simulator's UMD helpers (index.html)
const POLL_MS = 1500, STORE_MS = 10_000, LAG_MS = 2000;

async function call(path) {
  const res = await fetch(`/layerfs${path}`, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
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
  // ?pane=work|history opens that side of the view's Work | History switch (its per-viewer preference)
  const pane = new URLSearchParams(location.search).get("pane");
  if (pane === "work" || pane === "history") {
    try { localStorage.setItem("lfs-layout", JSON.stringify({ ...JSON.parse(localStorage.getItem("lfs-layout") || "{}"), pane })); } catch { /* not kept */ }
  }
  const root = document.getElementById("lfs");
  const b = createView(root, { avatars: heroAvatars((k) => `/dsh/packages/view/src/skins/heroes/images/${k}.png`), files: FM, lineDiff: M.lineDiff, live: false, lead: "main" });
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
