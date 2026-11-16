// The display in the browser: asks Helix for /display every two seconds and
// draws what view.ts makes of the answer. It needs no sign-in.
// It only reads. Sent to the browser with its types stripped (helix/src/ui.ts).
import type { Display } from '../src/display.ts';
import { view, type Live, type Project, type Recent, type View, type Waiting } from './view.ts';

const POLL_MS = 2000;
const RETRY_MS = 5000;
/** Past these many working agents the cards get narrower, then become rows. */
const MANY = 6;
const DENSE = 12;

const root = document.getElementById('helix')!;
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const state: {
  display?: Display;
  /** Helix's clock minus this browser's, in ms. */
  skew: number;
  offline: boolean;
  /** When Helix last answered, by this browser's clock. */
  heard?: Date;
} = { skew: 0, offline: false };

const esc = (s: string | number) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (n: number) => String(n).padStart(2, '0');
const wall = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const picked = () => { try { return decodeURIComponent(location.hash.slice(1)) || null; } catch { return null; } };

// ------------------------------------------------------------------ markup

const LOGO = `<svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
  <path class="s-ink" d="M6 3 C6 12 24 18 24 27" stroke-width="1.5"></path>
  <path class="s-accent" d="M24 3 C24 12 6 18 6 27" stroke-width="1.5"></path>
  <path class="s-ink" d="M9 8 H21 M11 15 H19 M9 22 H21" stroke-width="1"></path>
</svg>`;

const EMPTY_MARK = `<svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true">
  <g class="orbit"><circle class="s-line" cx="48" cy="48" r="45" stroke-width="1" stroke-dasharray="2 8"></circle></g>
  <path class="s-ink" d="M34 20 C34 40 62 56 62 76" stroke-width="1.5"></path>
  <path class="s-accent" d="M62 20 C62 40 34 56 34 76" stroke-width="1.5"></path>
  <path class="s-ink" d="M38 30 H58 M42 48 H54 M38 66 H58" stroke-width="1"></path>
</svg>`;

function header(v: View | undefined): string {
  const squares = v && v.slots <= 16 ? `<div class="squares">${Array.from({ length: v.slots }, (_, i) => `<span${i < v.running ? ' class="on"' : ''}></span>`).join('')}</div>` : '';
  const slots = v ? `${v.running}/${v.slots}` : 'connecting';
  return `<header class="head">
    <div class="brand">${LOGO}<div class="wordmark">HELIX</div>${v ? `<div class="machine">${esc(v.name)}</div>` : ''}</div>
    <div class="stats">
      <div class="stat-slots"><span class="k">SLOTS</span>${squares}<span class="b">${slots}</span></div>
      <div><span class="k">QUEUED</span> <span class="b">${v?.queued ?? 0}</span></div>
      <div><span class="k">NEEDS INPUT</span> <span class="asks">${v?.asks ?? 0}</span></div>
      <div class="time">${wall(new Date())}</div>
    </div>
  </header>
  <div class="rule"><span></span></div>`;
}

const offline = () => `<div class="offline" role="status">
  <span class="dot"></span><span class="what">CANNOT REACH HELIX</span>
  <span>${state.heard ? `This is the last state it reported, at ${wall(state.heard)}.` : 'It has not answered since this page was opened.'} Trying again every ${RETRY_MS / 1000} seconds.</span>
</div>`;

const project = (p: Project) => `<button type="button" class="project${p.busy ? ' busy' : ''}" data-key="p-${esc(p.id)}" data-pick="${esc(p.id)}" aria-pressed="${p.on}">
  <span class="project-top"><span class="project-name">${esc(p.id)}</span><span class="project-sum">${esc(p.summary)}</span></span>
  <span class="ticks" aria-hidden="true">${p.ticks.map((t) => `<span class="tick ${t}"></span>`).join('')}<span class="rest"></span></span>
</button>`;

const nav = (v: View) => `<nav class="nav" aria-label="Projects">
  <div class="nav-head label"><span>PROJECTS</span><span>${v.projects.length}</span></div>
  <button type="button" class="all" data-pick="" aria-pressed="${!v.sel}">ALL PROJECTS</button>
  ${v.projects.map(project).join('')}
  <div class="legend">
    <div><span class="tick running"></span>running</div>
    <div><span class="tick ended"></span>ended</div>
    <div><span class="tick ask"></span>needs input</div>
    <div><span class="tick queued"></span>queued</div>
  </div>
</nav>`;

const track = (v: View, j: Live) => `<span class="track" aria-hidden="true">${Array.from({ length: v.stages }, (_, i) => `<span class="seg${i < j.stage ? ' done' : i === j.stage ? ' on' : ''}"></span>`).join('')}</span>`;

const card = (v: View, j: Live) => `<article class="card" data-key="j-${j.id}">
  <span class="corner-a" aria-hidden="true"></span><span class="corner-b" aria-hidden="true"></span>
  <div class="card-top"><span><span class="b">#${j.id}</span> <span class="mute">${esc(j.repo)} · ${esc(j.person)}</span></span><span class="elapsed">${j.elapsed}</span></div>
  <div class="card-title">${esc(j.title)}</div>
  <div class="card-stage">${track(v, j)}<div class="card-step"><span class="stage-name">${esc(j.stageText)}</span><span class="mute">${esc(j.stepText)}</span></div></div>
  <div class="card-feed"><div class="mute">${esc(j.who)}</div><div class="now">&gt; ${esc(j.now)}<span class="cursor">_</span></div></div>
</article>`;

const row = (v: View, j: Live) => `<div class="row" data-key="j-${j.id}">
  <span class="id">#${j.id}</span><span class="repo">${esc(j.repo)}</span><span class="title">${esc(j.title)}</span>
  ${track(v, j)}<span class="stage">${esc(j.stageText)} <span class="step">${esc(j.stepShort)}</span></span><span class="elapsed">${j.elapsed}</span>
</div>`;

const waiting = (j: Waiting) => `<div class="wait${j.ask ? ' ask' : ''}" data-key="j-${j.id}">
  <span class="id">#${j.id}</span><span class="tag">${j.tag}</span><span class="title">${esc(j.title)}</span>
  <span class="by">${esc(j.repo)} · ${esc(j.person)}</span><span class="note">${esc(j.note)}</span>
</div>`;

const recent = (j: Recent) => `<div class="done-row" data-key="j-${j.id}">
  <span class="id">#${j.id}</span>
  ${j.href ? `<a class="tag tone-${j.tone}" href="${esc(j.href)}" target="_blank" rel="noopener noreferrer">${esc(j.tag)}</a>` : `<span class="tag tone-${j.tone}">${esc(j.tag)}</span>`}
  <span class="title">${esc(j.title)}</span><span class="by">${esc(j.meta)}</span>
  ${j.reason ? `<span class="reason tone-${j.tone}">${esc(j.reason)}</span>` : ''}
</div>`;

const section = (name: string, title: string, body: string, pulse = false) => `<section class="section ${name}">
  <div class="section-head label">${pulse ? '<span class="pulse"></span>' : ''}<h2>${title}</h2><span class="to-edge"></span></div>
  ${body}
</section>`;

function main(v: View): string {
  const scope = `<div class="scope">
    <div><div class="label">${v.sel ? 'PROJECT' : 'OVERVIEW'}</div><h1>${esc(v.title)}</h1></div>
    ${v.sel ? `<div class="facts" data-key="facts-${esc(v.sel.id)}">
      ${v.sel.base ? `<div><span class="mute">base</span> ${esc(v.sel.base)}</div>` : ''}
      ${v.sel.gates ? `<div><span class="mute">gates</span> ${esc(v.sel.gates)}</div>` : ''}
      <div><span class="mute">PRs opened</span> ${v.sel.prs}</div>
      <div><span class="mute">spent</span> ${v.sel.spent}</div>
    </div>` : ''}
  </div>`;
  if (v.empty) {
    return `<main class="main">${scope}<div class="empty">
      ${EMPTY_MARK}<h2>${esc(v.empty.title)}</h2><p>${esc(v.empty.text)}</p>
      <code>animus submit &lt;spec file&gt;</code><div class="free">${esc(v.empty.free)}</div>
    </div></main>`;
  }
  const live = !v.live.length ? `<div class="none boxed">${esc(v.noLive)}</div>`
    : v.live.length > DENSE ? `<div class="rows">${v.live.map((j) => row(v, j)).join('')}</div>`
    : `<div class="cards${v.live.length > MANY ? ' many' : ''}">${v.live.map((j) => card(v, j)).join('')}</div>`;
  return `<main class="main">${scope}
    ${section('live', `AGENTS WORKING NOW · ${v.live.length}`, live, true)}
    ${section('waiting', `WAITING · ${v.waiting.length}`, v.waiting.length ? v.waiting.map(waiting).join('') : '<div class="none">Nothing queued, and no job is waiting for an answer.</div>')}
    ${section('recent', `RECENT · ${v.recent.length}`, v.recent.length ? v.recent.map(recent).join('') : '<div class="none">No job has ended here yet.</div>')}
  </main>`;
}

function page(): string {
  // While Helix is out of reach the clock it was last read at stands still, and so does every count of time.
  const now = (state.offline && state.heard ? state.heard.getTime() : Date.now()) + state.skew;
  const v = state.display ? view(state.display, picked(), now) : undefined;
  return [
    header(v),
    state.offline ? offline() : '',
    v ? `<div class="body">${nav(v)}${main(v)}</div>` : '',
  ].join('');
}

// ----------------------------------------------------------------- drawing

const keyOf = (n: Node) => (n instanceof Element ? n.getAttribute('data-key') : null);

/**
 * Makes `from` the same as `to` by changing only what differs, so an element
 * that is still on the page keeps its place: its animation does not start
 * again. Children that carry
 * data-key are matched by it; the rest by position.
 */
function morph(from: Element, to: Element): void {
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
  for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  const keyed = new Map<string, ChildNode>();
  for (const n of from.childNodes) { const k = keyOf(n); if (k) keyed.set(k, n); }
  let cursor = from.firstChild;
  for (const want of [...to.childNodes]) {
    const k = keyOf(want);
    const have = k ? keyed.get(k) : cursor && !keyOf(cursor) ? cursor : undefined;
    if (!have || have.nodeType !== want.nodeType || have.nodeName !== want.nodeName) {
      from.insertBefore(want, cursor);
      continue;
    }
    if (have === cursor) cursor = cursor.nextSibling; else from.insertBefore(have, cursor);
    if (k) keyed.delete(k);
    if (have instanceof Element) morph(have, want as Element);
    else if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
  }
  while (cursor) { const gone = cursor; cursor = cursor.nextSibling; gone.remove(); }
}

function draw(): void {
  const next = root.cloneNode(false) as HTMLElement;
  next.className = `hx${state.offline ? ' is-offline' : ''}`;
  next.innerHTML = page();
  morph(root, next);
}

// ------------------------------------------------------------------- Helix

let timer = 0;

async function poll(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const res = await fetch('/display', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Helix answered ${res.status}`);
    const display = (await res.json()) as Display;
    Object.assign(state, { display, skew: Date.parse(display.at) - Date.now(), offline: false, heard: new Date() });
  } catch {
    state.offline = true;
  }
  draw();
  timer = window.setTimeout(() => { void poll(); }, state.offline ? RETRY_MS : POLL_MS);
}

root.addEventListener('click', (event) => {
  const button = (event.target as Element).closest('[data-pick]');
  if (!button) return;
  const id = button.getAttribute('data-pick')!;
  // Picking the project that is already picked goes back to all of them.
  history.replaceState(null, '', id && id !== picked() ? `#${encodeURIComponent(id)}` : location.pathname + location.search);
  draw();
});

window.addEventListener('hashchange', draw);
window.setInterval(draw, 1000);
void poll();
