// The display in the browser: asks Helix for /display every two seconds and
// draws what view.ts makes of the answer, on the page its path names
// (pages.ts). The overview needs no sign-in; a job page needs the person's
// token, sent with each request for its data.
// It only reads. Sent to the browser with its types stripped (helix/src/ui.ts).
import { forgetToken, jobNotice, keepToken, peopleNotice, personNotice, readToken, route, takeToken } from './pages.ts';
import { atEnd, jobView, type JobPageView } from './job-view.ts';
import { keepOlder, peopleView, personView } from './people-view.ts';
import type { Display, JobPage, PeoplePage, PersonPage } from './shape.ts';
import { view, type Live, type Project, type Recent, type View, type Waiting } from './view.ts';

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
  /** On the people list: its data, and how Helix last answered for it. */
  people?: PeoplePage;
  peopleStatus?: number;
  /** On a person's page: its data (the newest jobs), the older jobs read since with "more", and how Helix last answered. */
  person?: PersonPage;
  older: { jobs: PersonPage['jobList']; more: boolean };
  personStatus?: number;
  /** Helix's clock minus this browser's, in ms. */
  skew: number;
  offline: boolean;
  /** When Helix last answered, by this browser's clock. */
  heard?: Date;
} = { skew: 0, offline: false, older: { jobs: [], more: false } };

/** A job's screenshots as this browser holds them, by where Helix serves each and when they were taken: retaken ones are read again. */
const shotUrls = new Map<string, string>();
const shotKey = (src: string) => `${src}@${state.job?.shots?.at ?? ''}`;

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
      <a class="k" href="/people">PEOPLE</a>
      <div class="time">${wall(new Date())}</div>
      ${readToken(storage) ? '<button type="button" class="sign-out" data-sign-out>SIGN OUT</button>' : ''}
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

/** A person named on a job, linking to their page. */
const who = (j: { person: string; personPage: string }) => `<a href="${esc(j.personPage)}">${esc(j.person)}</a>`;

const card = (v: View, j: Live) => `<article class="card" data-key="j-${j.id}">
  <span class="corner-a" aria-hidden="true"></span><span class="corner-b" aria-hidden="true"></span>
  <div class="card-top"><span><span class="b">#${j.id}</span> <span class="mute">${esc(j.repo)} · ${who(j)}</span></span><span class="elapsed">${j.elapsed}</span></div>
  <a class="card-title" href="${esc(j.page)}">${esc(j.title)}</a>
  <div class="card-stage">${track(v, j)}<div class="card-step"><span class="stage-name">${esc(j.stageText)}</span><span class="mute">${esc(j.stepText)}</span></div></div>
  <div class="card-feed"><div class="mute">${esc(j.who)}</div><div class="now">&gt; ${esc(j.now)}<span class="cursor">_</span></div></div>
</article>`;

const row = (v: View, j: Live) => `<div class="row" data-key="j-${j.id}">
  <span class="id">#${j.id}</span><span class="repo">${esc(j.repo)}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  ${track(v, j)}<span class="stage">${esc(j.stageText)} <span class="step">${esc(j.stepShort)}</span></span><span class="elapsed">${j.elapsed}</span>
</div>`;

const waiting = (j: Waiting) => `<div class="wait${j.ask ? ' ask' : ''}" data-key="j-${j.id}">
  <span class="id">#${j.id}</span><span class="tag">${j.tag}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  <span class="by">${esc(j.repo)} · ${who(j)}</span><span class="note">${esc(j.note)}</span>
</div>`;

const recent = (j: Recent) => `<div class="done-row" data-key="j-${j.id}">
  <span class="id">#${j.id}</span>
  ${j.href ? `<a class="tag tone-${j.tone}" href="${esc(j.href)}" target="_blank" rel="noopener noreferrer">${esc(j.tag)}</a>` : `<span class="tag tone-${j.tone}">${esc(j.tag)}</span>`}
  <a class="title" href="${esc(j.page)}">${esc(j.title)}</a><span class="by">${esc(j.repo)} · ${who(j)}${j.meta ? ` · ${esc(j.meta)}` : ''}</span>
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

function jobMain(id: number, now: number): string {
  const notice = jobNotice(id, readToken(storage) !== null, state.jobStatus);
  const v = state.job?.job.id === id ? jobView(state.job, now) : undefined;
  const facts = v ? `<div class="facts">${v.facts.map((f) => `<div><span class="mute">${esc(f.k)}</span> ${f.href ? `<a href="${esc(f.href)}" target="_blank" rel="noopener noreferrer">${esc(f.v)}</a>` : f.page ? `<a href="${esc(f.page)}">${esc(f.v)}</a>` : esc(f.v)}</div>`).join('')}</div>` : '';
  const scope = `<div class="scope"><div><div class="label">JOB #${id}</div><h1>${esc(v?.title ?? `Job #${id}`)}</h1></div>${notice ? '' : facts}</div>`;
  const body = notice ? `<div class="none boxed">${esc(notice.text)}</div>${notice.signIn ? signIn : ''}` : v ? jobSections(v) : '';
  return `<main class="main">${back}${scope}${body}</main>`;
}

function peopleList(): string {
  const notice = peopleNotice(readToken(storage) !== null, state.peopleStatus);
  if (notice) return `<div class="none boxed">${esc(notice)}</div>${signIn}`;
  if (!state.people) return '';
  const rows = peopleView(state.people).rows.map((p) => `<tr data-key="u-${esc(p.name)}">
    <td><a href="${esc(p.page)}">${esc(p.name)}</a></td><td>${esc(p.github)}</td><td>${esc(p.joined)}</td>
    <td class="num">${p.jobs}</td><td class="num">${p.prs}</td><td class="num">${esc(p.spent)}</td><td>${esc(p.last)}</td></tr>`).join('');
  return rows ? `<table class="people"><thead><tr><th>PERSON</th><th>GITHUB</th><th>JOINED</th><th class="num">JOBS</th><th class="num">PRS OPENED</th><th class="num">SPENT</th><th>LAST ACTIVITY</th></tr></thead><tbody>${rows}</tbody></table>` : none('Nobody has joined this Helix yet.');
}

function personSections(name: string): string {
  const notice = personNotice(name, readToken(storage) !== null, state.personStatus);
  if (notice) return `<div class="none boxed">${esc(notice)}</div>${readToken(storage) ? '' : signIn}`;
  if (state.person?.name !== name) return '';
  const v = personView(state.person, state.older);
  const facts = `<div class="facts">${v.facts.map((f) => `<div><span class="mute">${esc(f.k)}</span> ${esc(f.v)}</div>`).join('')}</div>`;
  const jobs = v.jobs.map((j) => `<div class="done-row" data-key="j-${j.id}">
    <span class="id">#${j.id}</span>${j.href ? `<a class="tag" href="${esc(j.href)}" target="_blank" rel="noopener noreferrer">${esc(j.tag)}</a>` : `<span class="tag">${esc(j.tag)}</span>`}
    <a class="title" href="${esc(j.page)}">${esc(j.title)}</a><span class="by">${esc(j.repo)} · ${esc(j.submitted)}</span></div>`).join('');
  const activity = v.activity.map((a, i) => `<div class="done-row" data-key="a-${i}"><span class="by">${esc(a.when)}</span>${a.page ? `<a class="title" href="${esc(a.page)}">${esc(a.text)}</a>` : `<span class="title">${esc(a.text)}</span>`}${a.note ? `<span class="reason">${esc(a.note)}</span>` : ''}</div>`).join('');
  return [
    v.left ? `<div class="none boxed">${esc(v.left)}</div>` : '', facts,
    section('jobs', 'JOBS', (jobs || none('No job yet.')) + (v.more ? '<button type="button" class="more" data-more>SHOW MORE</button>' : '')),
    section('activity', 'ACTIVITY', activity || none('Nothing kept yet.')),
  ].join('');
}

const peopleMain = (name?: string) => `<main class="main">${back}
  <div class="scope"><div><div class="label">${name ? 'PERSON' : 'PEOPLE'}</div><h1>${esc(name ?? 'People')}</h1></div></div>
  ${name ? personSections(name) : peopleList()}
</main>`;

function page(): string {
  // While Helix is out of reach the clock it was last read at stands still, and so does every count of time.
  const now = (state.offline && state.heard ? state.heard.getTime() : Date.now()) + state.skew;
  const v = state.display ? view(state.display, picked(), now) : undefined;
  const body = at.page === 'job' ? jobMain(at.id, now) : at.page === 'people' ? peopleMain(at.name) : v ? `${nav(v)}${main(v)}` : '';
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
async function readJob(id: number): Promise<void> {
  const token = readToken(storage);
  if (!token) return;
  const res = await fetch(`/jobs/${id}/page-data`, { cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
  state.jobStatus = res.status;
  if (res.status === 401) forgetToken(storage);
  if (!res.ok) return;
  state.job = (await res.json()) as JobPage;
  await readShots(state.job, token);
}

/** The people list's data, with the token as it is kept now; a token Helix refuses is forgotten. */
async function readPeople(): Promise<void> {
  const token = readToken(storage);
  if (!token) return;
  const res = await fetch('/people/page-data', { cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
  state.peopleStatus = res.status;
  if (res.status === 401) forgetToken(storage);
  if (res.ok) state.people = (await res.json()) as PeoplePage;
}

/** A person's page data, with the token as it is kept now; `before` reads the jobs older than that one. A token Helix refuses is forgotten. */
async function readPerson(name: string, before?: number): Promise<void> {
  const token = readToken(storage);
  if (!token) return;
  const res = await fetch(`/people/${encodeURIComponent(name)}/page-data${before ? `?before=${before}` : ''}`, { cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
  if (before === undefined) state.personStatus = res.status;
  if (res.status === 401) forgetToken(storage);
  if (!res.ok) return;
  const data = (await res.json()) as PersonPage;
  if (before === undefined) {
    // Once older jobs were read, a refresh must not leave a job between the two lists.
    if (state.person && state.older.jobs.length) state.older.jobs = keepOlder(state.person, state.older.jobs, data);
    state.person = data;
  }
  else state.older = { jobs: [...state.older.jobs, ...data.jobList], more: data.more };
}

/** Fetches with the token each screenshot this browser does not hold yet, and lets go of the ones the job no longer has. */
async function readShots(page: JobPage, token: string): Promise<void> {
  const srcs = jobView(page, 0).shots.map((s) => s.src);
  const keys = srcs.map(shotKey);
  for (const [k, u] of shotUrls) if (!keys.includes(k)) { URL.revokeObjectURL(u); shotUrls.delete(k); }
  await Promise.all(srcs.filter((src) => !shotUrls.has(shotKey(src))).map(async (src) => {
    const res = await fetch(src, { cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
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
    const [res] = await Promise.all([fetch('/display', { cache: 'no-store' }), at.page === 'job' ? readJob(at.id) : at.page === 'people' ? (at.name ? readPerson(at.name) : readPeople()) : undefined]);
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
  Object.assign(state, { jobStatus: undefined, peopleStatus: undefined, personStatus: undefined });
  void poll();
});

root.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-sign-out]')) {
    forgetToken(storage);
    forgetShots();
    Object.assign(state, { job: undefined, jobStatus: undefined, people: undefined, peopleStatus: undefined, person: undefined, personStatus: undefined, older: { jobs: [], more: false } });
    draw();
    return;
  }
  if ((event.target as Element).closest('[data-more]') && at.page === 'people' && at.name && state.person) {
    const last = [...state.person.jobList, ...state.older.jobs].at(-1);
    void readPerson(at.name, last?.id).then(draw);
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
window.setInterval(draw, 1000);
void poll();
