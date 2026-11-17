// The display in the browser: asks Helix for /display every two seconds and
// draws what view.ts makes of the answer, on the page its path names
// (pages.ts). The overview needs no sign-in; a job page needs the person's
// token, sent with each request for its data.
// It only reads. Sent to the browser with its types stripped (helix/src/ui.ts).
import { forgetToken, jobNotice, keepToken, readToken, route, takeToken } from './pages.ts';
import { atEnd, jobView, type JobPageView } from './job-view.ts';
import type { Display, JobPage } from './shape.ts';
import { view, type Live, type Pr, type Project, type Recent, type View, type Waiting } from './view.ts';

const POLL_MS = 2000;
const RETRY_MS = 5000;
/** Past these many working agents the cards get narrower, then become rows. */
const MANY = 6;
const DENSE = 12;

const root = document.getElementById('helix')!;
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
const storage = () => window.localStorage;
// A token in the address is kept, and taken out of it before anything reads the hash.
if (takeToken(location.hash, storage)) history.replaceState(null, '', location.pathname + location.search);
const at = route(location.pathname);

const state: {
  display?: Display;
  /** On a job page: its data, and how Helix last answered for it. */
  job?: JobPage;
  jobStatus?: number;
  /** Helix's clock minus this browser's, in ms. */
  skew: number;
  offline: boolean;
  /** When Helix last answered, by this browser's clock. */
  heard?: Date;
} = { skew: 0, offline: false };

/** A job's screenshots as this browser holds them, by where Helix serves each and when they were taken: retaken ones are read again. */
const shotUrls = new Map<string, string>();
const shotKey = (src: string) => `${src}@${state.job?.shots?.at ?? ''}`;

const esc = (s: string | number) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (n: number) => String(n).padStart(2, '0');
const wall = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** A Helix job's number as `#7`; a local job is named by its title, not its long id. */
const ref = (id: number | string) => (typeof id === 'number' ? `#${id}` : '');
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

/**
 * The idle animation: the Helix mark unwinds into a slowly turning double helix
 * of light, with glitch fragments and a word. Inline SVG and CSS transforms only
 * (helix.css): no canvas, no frame loop. Each rung of the helix is flat when its
 * --s is 1 and edge-on at 0; --s is also its resting pose under reduced motion.
 * The per-rung --s and phase are rules in helix.css: the CSP allows no style attribute.
 */
const RUNGS = 16;
const rungs = Array.from({ length: RUNGS }, (_, i) => `<g transform="translate(200 ${22 + i * 11})"><g class="sync-rung">
    <line class="s-line" x1="-60" x2="60" stroke-width="1"></line><circle class="f-accent" cx="-60" r="4"></circle><circle class="f-ink" cx="60" r="4"></circle></g></g>`).join('');
const SYNC = `<div class="sync" data-key="sync" role="img" aria-label="Synchronizing">
  <div class="sync-drift"><svg viewBox="0 0 400 220" fill="none" aria-hidden="true">
    <g class="sync-mark" transform="translate(200 110)"><g class="sync-unwind">
      <path class="s-ink" d="M-24 -48 C-24 -20 24 0 24 48" stroke-width="2"></path>
      <path class="s-accent" d="M24 -48 C24 -20 -24 0 -24 48" stroke-width="2"></path>
      <path class="s-ink" d="M-18 -32 H18 M-12 0 H12 M-18 32 H18" stroke-width="1.5"></path>
    </g></g>
    <g class="sync-helix">${rungs}</g>
    <g class="sync-glitch"><rect class="f-accent" x="120" y="60" width="46" height="2"></rect><rect class="f-ink" x="238" y="132" width="30" height="2"></rect><rect class="f-accent" x="170" y="176" width="64" height="1"></rect></g>
  </svg><div class="sync-word">SYNCHRONIZING</div></div>
</div>`;

function header(v: View | undefined): string {
  const squares = v && v.slots <= 16 ? `<div class="squares">${Array.from({ length: v.slots }, (_, i) => `<span${i < v.running ? ' class="on"' : ''}></span>`).join('')}</div>` : '';
  const slots = v ? `${v.running}/${v.slots}` : 'connecting';
  return `<header class="head">
    <div class="brand">${LOGO}<div class="wordmark">HELIX</div>${v ? `<div class="machine">${esc(v.name)}</div>` : ''}</div>
    <div class="stats">
      ${v?.local ? `<div><span class="k">RUNNING</span> <span class="b">${v.running}</span></div>`
        : `<div class="stat-slots"><span class="k">SLOTS</span>${squares}<span class="b">${slots}</span></div>
      <div><span class="k">QUEUED</span> <span class="b">${v?.queued ?? 0}</span></div>`}
      <div><span class="k">NEEDS INPUT</span> <span class="asks">${v?.asks ?? 0}</span></div>
      <div class="time">${wall(new Date())}</div>
      ${readToken(storage) && !v?.local ? '<button type="button" class="sign-out" data-sign-out>SIGN OUT</button>' : ''}
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
  <div class="card-top"><span><span class="b">${ref(j.id)}</span> <span class="mute">${esc(j.repo)} · ${esc(j.person)}</span></span><span class="elapsed">${j.elapsed}</span></div>
  <a class="card-title" href="${esc(j.page)}">${esc(j.title)}</a>
  <div class="card-stage">${track(v, j)}<div class="card-step"><span class="stage-name">${esc(j.stageText)}</span><span class="mute">${esc(j.stepText)}</span></div></div>
  <div class="card-feed"><div class="mute">${esc(j.who)}</div><div class="now">&gt; ${esc(j.now)}<span class="cursor">_</span></div></div>
</article>`;

const row = (v: View, j: Live) => `<div class="row" data-key="j-${j.id}">
  <span class="id">${ref(j.id)}</span><span class="repo">${esc(j.repo)}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  ${track(v, j)}<span class="stage">${esc(j.stageText)} <span class="step">${esc(j.stepShort)}</span></span><span class="elapsed">${j.elapsed}</span>
</div>`;

const waiting = (j: Waiting) => `<div class="wait${j.ask ? ' ask' : ''}" data-key="j-${j.id}">
  <span class="id">${ref(j.id)}</span><span class="tag">${j.tag}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  <span class="by">${esc(j.repo)} · ${esc(j.person)}</span><span class="note">${esc(j.note)}</span>
</div>`;

const recent = (j: Recent) => `<div class="done-row" data-key="j-${j.id}">
  <span class="id">${ref(j.id)}</span>
  <span class="tag tone-${j.tone}">${esc(j.tag)}</span>
  <a class="title" href="${esc(j.page)}">${esc(j.title)}</a><span class="by">${esc(j.meta)}</span>
  ${j.reason ? `<span class="reason tone-${j.tone}">${esc(j.reason)}</span>` : ''}
</div>`;

const openPr = (p: Pr) => `<div class="done-row" data-key="pr-${esc(p.href)}">
  <span class="id">#${p.id}</span>
  <a class="tag tone-${p.draft ? 'ask' : 'ink'}" href="${esc(p.href)}" target="_blank" rel="noopener noreferrer">${esc(p.tag)}</a>
  <a class="title" href="${esc(p.page)}">${esc(p.title)}</a><span class="by">${esc(p.meta)}</span>
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
      ${v.idle ? SYNC : EMPTY_MARK}<h2>${esc(v.empty.title)}</h2><p>${esc(v.empty.text)}</p>
      <code>${esc(v.empty.command)}</code>${v.empty.free ? `<div class="free">${esc(v.empty.free)}</div>` : ''}
    </div></main>`;
  }
  const live = v.idle ? SYNC : !v.live.length ? `<div class="none boxed">${esc(v.noLive)}</div>`
    : v.live.length > DENSE ? `<div class="rows">${v.live.map((j) => row(v, j)).join('')}</div>`
    : `<div class="cards${v.live.length > MANY ? ' many' : ''}">${v.live.map((j) => card(v, j)).join('')}</div>`;
  const lists = v.local
    ? v.byProject.map((g) => section('recent', `${esc(g.project.toUpperCase())} · ${g.jobs.length}`, g.jobs.map(recent).join(''))).join('')
    : `${section('prs', `OPEN PRS · ${v.prs.length}`, v.prs.length ? v.prs.map(openPr).join('') : '<div class="none">No pull request opened by these jobs is open.</div>')}
    ${section('recent', `RECENT · ${v.recent.length}`, v.recent.length ? v.recent.map(recent).join('') : '<div class="none">No job has failed or been cancelled here.</div>')}`;
  return `<main class="main">${scope}
    ${section('live', `AGENTS WORKING NOW · ${v.live.length}`, live, true)}
    ${section('waiting', `WAITING · ${v.waiting.length}`, v.waiting.length ? v.waiting.map(waiting).join('') : `<div class="none">${v.local ? 'No job is waiting for an answer.' : 'Nothing queued, and no job is waiting for an answer.'}</div>`)}
    ${lists}
  </main>`;
}

const back = '<a class="back" href="/">&larr; OVERVIEW</a>';

const signIn = `<form class="sign-in" data-sign-in>
  <label for="token" class="label">HELIX TOKEN</label>
  <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
  <button type="submit">SIGN IN</button>
</form>`;

const pre = (text: string, attrs = '') => `<pre class="text"${attrs}>${esc(text)}</pre>`;
const none = (text: string) => `<div class="none">${esc(text)}</div>`;

function jobSections(v: JobPageView): string {
  const stages = `<div class="steps">${v.stages.map((s) => `<div class="step-row${s.on ? ' on' : ''}"><span>${esc(s.name)}</span><span class="mute">${s.on ? 'now' : esc(s.took)}</span></div>`).join('')}</div>`;
  const slices = v.slices.length ? `<ol class="slices">${v.slices.map((s) => `<li${s.done ? ' class="done"' : ''}><span class="b">${esc(s.title)}</span> <span class="mute">${s.done ? 'done' : ''}</span><div class="mute">${esc(s.delivers)}</div></li>`).join('')}</ol>` : '';
  const checks = v.checks.map((c) => `<div class="check"><span class="tag tone-${c.tone}">${esc(c.tag)}</span><span class="b">${esc(c.name)}</span><code>${esc(c.command)}</code><span class="mute">${esc(c.detail)}</span>${c.output !== undefined ? pre(c.output) : ''}</div>`).join('');
  const reviews = v.reviews.map((r) => `<div class="round"><div class="label">${esc(r.title.toUpperCase())}</div><p>${esc(r.summary)}</p>
    ${r.findings.map((f) => `<div class="finding"><span class="tag tone-${f.tone}">${esc(f.tag)}</span>${f.where ? `<code>${esc(f.where)}</code>` : ''}<p>${esc(f.problem)}</p>${f.fix ? `<p class="mute">${esc(f.fix)}</p>` : ''}</div>`).join('') || none('No findings.')}</div>`).join('');
  const shots = v.shots.map((s) => {
    const src = shotUrls.get(shotKey(s.src));
    return `<figure class="shot" data-key="s-${esc(s.src)}">${src ? `<img src="${esc(src)}" alt="${esc(s.name)}">` : none('Loading…')}<figcaption>${esc(s.name)}</figcaption></figure>`;
  }).join('');
  const questions = v.questions.map((q) => `<div class="qa"><p><span class="label">ASKED</span> ${esc(q.question)}</p><p${q.answered ? '' : ' class="tone-ask"'}><span class="label">ANSWERED</span> ${esc(q.answer)}</p></div>`).join('');
  return [
    v.reason ? `<pre class="text why">${esc(v.reason)}</pre>` : '',
    section('stages', 'STAGES', `${stages}${slices}`),
    section('checks', 'CHECKS', checks || none('No checks have run yet.')),
    section('review', 'REVIEW', reviews || none('Not reviewed yet.')),
    shots ? section('screenshots', 'SCREENSHOTS', `<div class="shots">${shots}</div>`) : '',
    section('questions', 'QUESTIONS', questions || none('It has asked nothing.')),
    section('spec', 'SPEC', v.spec ? pre(v.spec) : none('Helix no longer has the spec.')),
    section('log', 'LOG', v.log ? pre(v.log, ' data-log') : none('It has printed nothing yet.'), v.follow),
  ].join('');
}

function jobMain(id: number | string, now: number, local: boolean): string {
  const notice = jobNotice(id, readToken(storage) !== null, state.jobStatus, local);
  const v = state.job?.job.id === id ? jobView(state.job, now) : undefined;
  const facts = v ? `<div class="facts">${v.facts.map((f) => `<div><span class="mute">${esc(f.k)}</span> ${f.href ? `<a href="${esc(f.href)}" target="_blank" rel="noopener noreferrer">${esc(f.v)}</a>` : esc(f.v)}</div>`).join('')}</div>` : '';
  const scope = `<div class="scope"><div><div class="label">JOB${typeof id === 'number' ? ` #${id}` : ''}</div><h1>${esc(v?.title ?? `Job ${ref(id) || id}`)}</h1></div>${notice ? '' : facts}</div>`;
  const body = notice ? `<div class="none boxed">${esc(notice.text)}</div>${notice.signIn ? signIn : ''}` : v ? jobSections(v) : '';
  return `<main class="main">${back}${scope}${body}</main>`;
}

const peopleMain = (name?: string) => `<main class="main">${back}
  <div class="scope"><div><div class="label">${name ? 'PERSON' : 'PEOPLE'}</div><h1>${esc(name ?? 'People')}</h1></div></div>
  <div class="none boxed">This page is coming: who is on this Helix and what each person has run.</div>
</main>`;

function page(): string {
  // While Helix is out of reach the clock it was last read at stands still, and so does every count of time.
  const now = (state.offline && state.heard ? state.heard.getTime() : Date.now()) + state.skew;
  const v = state.display ? view(state.display, picked(), now) : undefined;
  // A job page waits for the display: whether it needs a sign-in depends on the source it answers.
  const body = at.page === 'job' ? (state.display ? jobMain(at.id, now, state.display.local === true) : '') : at.page === 'people' ? peopleMain(at.name) : v ? `${nav(v)}${main(v)}` : '';
  return [
    header(v),
    state.offline ? offline() : '',
    body ? `<div class="body">${body}</div>` : '',
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
  // A running job's log keeps to its end, unless the person has scrolled up to read it.
  const log = root.querySelector('[data-log]');
  const follow = !log || atEnd(log);
  const next = root.cloneNode(false) as HTMLElement;
  next.className = `hx${state.offline ? ' is-offline' : ''}`;
  next.innerHTML = page();
  morph(root, next);
  const drawn = root.querySelector('[data-log]');
  if (drawn && follow && state.job && jobView(state.job, 0).follow) drawn.scrollTop = drawn.scrollHeight;
}

// ------------------------------------------------------------------- Helix

let timer = 0;

/** A job page's data, with the token as it is kept now; a token Helix refuses is forgotten. */
async function readJob(id: number | string): Promise<void> {
  const token = readToken(storage);
  // Without a token it is asked all the same: the local display needs none, and Helix's 401 then only means a sign-in is due.
  const res = await fetch(`/jobs/${encodeURIComponent(id)}/page-data`, { cache: 'no-store', headers: auth(token) });
  state.jobStatus = res.status === 401 && !token ? undefined : res.status;
  if (res.status === 401 && token) forgetToken(storage);
  if (!res.ok) return;
  state.job = (await res.json()) as JobPage;
  await readShots(state.job, token);
}

const auth = (token: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Fetches with the token (if there is one) each screenshot this browser does not hold yet, and lets go of the ones the job no longer has. */
async function readShots(page: JobPage, token: string | null): Promise<void> {
  const srcs = jobView(page, 0).shots.map((s) => s.src);
  const keys = srcs.map(shotKey);
  for (const [k, u] of shotUrls) if (!keys.includes(k)) { URL.revokeObjectURL(u); shotUrls.delete(k); }
  await Promise.all(srcs.filter((src) => !shotUrls.has(shotKey(src))).map(async (src) => {
    const res = await fetch(src, { cache: 'no-store', headers: auth(token) });
    // One that is being taken again is read on a later poll.
    if (res.ok) shotUrls.set(shotKey(src), URL.createObjectURL(await res.blob()));
  }));
}

function forgetShots(): void {
  for (const u of shotUrls.values()) URL.revokeObjectURL(u);
  shotUrls.clear();
}

async function poll(): Promise<void> {
  window.clearTimeout(timer);
  try {
    const [res] = await Promise.all([fetch('/display', { cache: 'no-store' }), at.page === 'job' ? readJob(at.id) : undefined]);
    if (!res.ok) throw new Error(`Helix answered ${res.status}`);
    const display = (await res.json()) as Display;
    Object.assign(state, { display, skew: Date.parse(display.at) - Date.now(), offline: false, heard: new Date() });
  } catch {
    state.offline = true;
  }
  draw();
  timer = window.setTimeout(() => { void poll(); }, state.offline ? RETRY_MS : POLL_MS);
}

root.addEventListener('submit', (event) => {
  const form = (event.target as Element).closest('[data-sign-in]');
  if (!form) return;
  event.preventDefault();
  keepToken(storage, (form.querySelector('input') as HTMLInputElement).value);
  state.jobStatus = undefined;
  void poll();
});

root.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-sign-out]')) {
    forgetToken(storage);
    forgetShots();
    Object.assign(state, { job: undefined, jobStatus: undefined });
    draw();
    return;
  }
  const button = (event.target as Element).closest('[data-pick]');
  if (!button) return;
  const id = button.getAttribute('data-pick')!;
  // Picking the project that is already picked goes back to all of them.
  history.replaceState(null, '', id && id !== picked() ? `#${encodeURIComponent(id)}` : location.pathname + location.search);
  draw();
});

window.addEventListener('hashchange', draw);
// helix.css holds every animation still while the tab is hidden.
document.addEventListener('visibilitychange', () => document.documentElement.toggleAttribute('data-hidden', document.hidden));
window.setInterval(draw, 1000);
void poll();
