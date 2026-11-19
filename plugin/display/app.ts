// The display in the browser: asks Helix for /display every two seconds and
// draws what view.ts makes of the answer, on the page its path names
// (pages.ts). The overview needs no sign-in; a job page needs the person's
// token, sent with each request for its data.
// It only reads. Sent to the browser with its types stripped (helix/src/ui.ts).
import { forgetToken, insightsNotice, jobNotice, jobsNotice, keepToken, peopleNotice, personNotice, readToken, route, takeToken } from './pages.ts';
import { atEnd, jobView, type JobPageView } from './job-view.ts';
import { keepOlder, peopleView, personView } from './people-view.ts';
import { insightsView, scopeOf } from './insights-view.ts';
import { filterOf, jobListView, queryOf, RESULTS, type JobRow } from './job-list.ts';
import type { Display, InsightsPage, JobListPage, JobPage, PeoplePage, PersonPage } from './shape.ts';
import { view, type Live, type Pr, type Project, type Need, type Recent, type View, type Waiting } from './view.ts';

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
  /** On the Jobs page: the newest thirty matching the address, the older ones read since with SHOW MORE, and how Helix last answered. */
  list?: JobListPage;
  listOlder: JobListPage['jobs'];
  listMore: boolean;
  listStatus?: number;
  personStatus?: number;
  /** On the Insights page: its data for the address's scope, and how Helix last answered for it. */
  insights?: InsightsPage;
  insightsStatus?: number;
  /** Helix's clock minus this browser's, in ms. */
  skew: number;
  offline: boolean;
  /** When Helix last answered, by this browser's clock. */
  heard?: Date;
} = { skew: 0, offline: false, older: { jobs: [], more: false }, listOlder: [], listMore: false };

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
    <div class="brand">${LOGO}<div class="machine">${esc(v?.name ?? 'Helix')}</div></div>
    <nav class="tabs" aria-label="Pages">
      ${[['Overview', '/', 'overview'], ['Jobs', '/jobs', 'jobs'], ['Insights', '/insights', 'insights'], ...(v?.people === false ? [] : [['People', '/people', 'people']])].map(([name, href, key]) => `<a href="${href}"${at.page === key || (key === 'jobs' && at.page === 'job') ? ' aria-current="page"' : ''}>${name}</a>`).join('')}
    </nav>
    <div class="stats">
      ${v?.local ? `<div><span class="k">running</span> <span class="b">${v.running}</span></div>`
        : `<div class="stat-slots"><span class="k">slots</span>${squares}<span class="b">${slots}</span></div>`}
      <div class="time">${wall(new Date())}</div>
      ${readToken(storage) && !v?.local ? '<button type="button" class="sign-out" data-sign-out>Sign out</button>' : ''}
    </div>
  </header>`;
}

const offline = () => `<div class="offline" role="status">
  <span class="dot"></span><span class="what">Cannot reach Helix</span>
  <span>${state.heard ? `This is the last state it reported, at ${wall(state.heard)}.` : 'It has not answered since this page was opened.'} Trying again every ${RETRY_MS / 1000} seconds.</span>
</div>`;

const project = (p: Project) => `<button type="button" class="project${p.busy ? ' busy' : ''}" data-key="p-${esc(p.id)}" data-pick="${esc(p.id)}" aria-pressed="${p.on}">
  <span class="project-top"><span class="project-name">${esc(p.id)}</span><span class="project-sum">${esc(p.summary)}</span></span>
  <span class="ticks" aria-hidden="true">${p.ticks.map((t) => `<span class="tick ${t}"></span>`).join('')}<span class="rest"></span></span>
</button>`;

const week = (v: View) => `<section class="panel week" data-key="week">
  <h2>This week</h2>
  <dl>
    <div><dt>PRs merged</dt><dd>${v.week.merged}</dd></div><div><dt>Gates first time</dt><dd>${v.week.firstPass}</dd></div>
    <div><dt>Per merged PR</dt><dd>${v.week.perMerged}</dd></div><div><dt>Median job</dt><dd>${v.week.median}</dd></div>
  </dl>
  <a class="more-link" href="/insights">Insights →</a>
</section>`;

const nav = (v: View) => `<aside class="side">${week(v)}<nav class="panel projects" aria-label="Projects">
  <h2>Projects <span class="count">${v.projects.length}</span></h2>
  ${v.projects.map(project).join('')}
  <div class="key"><span><i class="merged"></i>merged</span><span><i class="running"></i>running</span><span><i class="ask"></i>asks</span><span><i class="failed"></i>failed</span></div>
</nav></aside>`;

const track = (v: View, j: Live) => `<span class="track" aria-hidden="true">${Array.from({ length: v.stages }, (_, i) => `<span class="seg${i < j.stage ? ' done' : i === j.stage ? ' on' : ''}"></span>`).join('')}</span>`;

/** A person named on a job, linking to their page. */
const who = (j: { person: string; personPage?: string }) => (j.personPage ? `<a href="${esc(j.personPage)}">${esc(j.person)}</a>` : esc(j.person));

const card = (v: View, j: Live) => `<article class="card" data-key="j-${j.id}">
  <div class="card-top"><span><span class="b">${ref(j.id)}</span> <span class="mute">${j.by.map((b) => (b.page ? `<a href="${esc(b.page)}">${esc(b.text)}</a>` : esc(b.text))).join(' · ')}</span></span><span class="elapsed">${j.elapsed}</span></div>
  <a class="card-title" href="${esc(j.page)}">${esc(j.title)}</a>
  <div class="card-stage">${track(v, j)}<div class="card-step"><span class="stage-name">${esc(j.stageText)}</span><span class="mute">${esc(j.stepText)}</span></div></div>
  <div class="card-feed"><div class="mute">${esc(j.who)}</div>${j.now ? `<div class="now">&gt; ${esc(j.now)}<span class="cursor">_</span></div>` : ''}</div>
</article>`;

const row = (v: View, j: Live) => `<div class="row" data-key="j-${j.id}">
  <span class="id">${ref(j.id)}</span><span class="repo">${esc(j.repo)}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  ${track(v, j)}<span class="stage">${esc(j.stageText)} <span class="step">${esc(j.stepShort)}</span></span><span class="elapsed">${j.elapsed}</span>
</div>`;

const queued = (j: Waiting) => `<div class="wait" data-key="j-${j.id}">
  <span class="id">${ref(j.id)}</span><span class="tag">${j.tag}</span><a class="title" href="${esc(j.page)}">${esc(j.title)}</a>
  <span class="by">${esc(j.repo)} · ${who(j)}</span><span class="note">${esc(j.note)}</span>
</div>`;

const need = (j: Need) => `<article class="ask-card" data-key="j-${j.id}">
  <p class="question">${esc(j.question)}</p>
  <div class="by"><span class="id">${ref(j.id)}</span> ${esc(j.repo)} · <a href="${esc(j.page)}">${esc(j.title)}</a> · waiting <span class="mono">${esc(j.waited)}</span></div>
  <div class="ask-act"><code>${esc(j.command)}</code><a class="ask-btn" href="${esc(j.page)}">Open job</a></div>
</article>`;

const recent = (j: Recent) => `<div class="done-row" data-key="j-${j.id}">
  ${j.href ? `<a class="tag tone-${j.tone}" href="${esc(j.href)}" target="_blank" rel="noopener noreferrer">${esc(j.tag)}</a>` : `<span class="tag tone-${j.tone}">${esc(j.tag)}</span>`}
  <a class="title" href="${esc(j.page)}">${esc(j.title)}</a><span class="by">${[ref(j.id), esc(j.repo), who(j), esc(j.meta)].filter(Boolean).join(' · ')}</span>
  ${j.reason ? `<span class="reason tone-${j.tone}">${esc(j.reason)}</span>` : ''}
</div>`;

const openPr = (p: Pr) => `<div class="done-row" data-key="pr-${esc(p.href)}">
  <a class="tag tone-${p.draft ? 'mute' : 'open'}" href="${esc(p.href)}" target="_blank" rel="noopener noreferrer">${esc(p.tag)}</a>
  <a class="title" href="${esc(p.page)}">${esc(p.title)}</a><span class="by">#${p.id} · ${esc(p.repo)} · ${who(p)}</span>
</div>`;

const section = (name: string, title: string, body: string, pulse = false, more = '') => `<section class="section ${name}">
  <div class="section-head">${pulse ? '<span class="pulse"></span>' : ''}<h2>${title}</h2><span class="to-edge"></span>${more}</div>
  ${body}
</section>`;

function main(v: View): string {
  const h = v.headline;
  const scope = `<div class="scope">
    <div>${v.sel ? `<div class="project-title">${esc(v.title)}</div>` : ''}<h1 class="headline">${h.needs ? `<span class="needs">${esc(h.needs)}</span> ` : ''}${esc(h.rest)}</h1>
      ${h.last ? `<div class="last">${esc(h.last.when)} · <span class="tag tone-${h.last.tone}">${esc(h.last.tag)}</span></div>` : ''}</div>
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
  const lists = `${v.prs.length ? section('prs', `Open pull requests <span class="count">${v.prs.length}</span>`, v.prs.map(openPr).join('')) : ''}
    ${v.finished.length ? section('recent', `Finished <span class="count">${v.finished.length}</span>`, v.finished.map(recent).join(''), false, '<a class="all-jobs" href="/jobs">All jobs →</a>') : ''}`;
  return `<main class="main">${scope}
    ${v.needs.length ? section('needs', `Needs you <span class="count">${v.needs.length}</span>`, v.needs.map(need).join('')) : ''}
    ${section('live', `Working now <span class="count">${v.live.length}</span>`, live, true)}
    ${v.line.length ? section('waiting', `Queued <span class="count">${v.queued}</span>`, v.line.map(queued).join('')) : ''}
    ${lists}
  </main>`;
}

const back = (href: string, name: string) => `<a class="back" href="${href}">&larr; ${name}</a>`;

const signIn = `<form class="sign-in" data-sign-in>
  <label for="token" class="label">Helix token</label>
  <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
  <button type="submit">Sign in</button>
</form>`;

const pre = (text: string, attrs = '') => `<pre class="text"${attrs}>${esc(text)}</pre>`;
const none = (text: string) => `<div class="none">${esc(text)}</div>`;

function jobSections(v: JobPageView): string {
  // Each stage is its own nested svg so its name is clipped to its part; the CSP allows no style attribute, so widths are percentages in attributes.
  const stages = v.bar.length ? `<svg class="timebar" role="img" aria-label="Where the time went">${v.bar.map((s) => `<svg x="${s.at}%" width="${s.pct}%" height="28"><rect class="st-${esc(s.name)}" width="100%" height="28"/>${s.label ? `<text x="8" y="18">${esc(s.label)}</text>` : ''}</svg>`).join('')}</svg>
    <div class="timekey">${v.bar.map((s) => `<span class="${s.on ? 'on' : ''}"><i class="st-${esc(s.name)}"></i>${esc(s.name)} <code>${s.on ? 'now' : esc(s.took)}</code></span>`).join('')}</div>` : '';
  const fold = (name: string, title: string, body: string, open = false) => `<details class="fold ${name}" data-key="fold-${name}"${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
  const mark = (tone: string, tag: string) => `<span class="mark tone-${tone}" aria-label="${tone === 'fail' ? 'failed' : tone === 'ink' ? 'passed' : esc(tag)}">${esc(tag)}</span>`;
  const criteria = v.criteria.map((c) => `<div class="criterion">${mark(c.tone, c.tag)}<div class="what"><p>${esc(c.text)}</p>${c.command ? `<code>${esc(c.command)}</code>` : ''}</div>${c.output ? `<details class="out"><summary>output</summary>${pre(c.output)}</details>` : ''}</div>`).join('');
  const pills = v.pills.map((c) => c.output ? `<details class="chip"><summary>${mark(c.tone, c.tag)}${esc(c.name)}</summary>${pre(c.output)}</details>` : `<span class="chip" title="${esc(c.command)}">${mark(c.tone, c.tag)}${esc(c.name)}</span>`).join('');
  const chips = pills + v.flaky.map((f) => `<span class="chip mute">${esc(f)}</span>`).join('');
  const note = (text: string) => (text ? ` <span class="count">${esc(text)}</span>` : '');
  const slices = v.slices.length ? `<ol class="slices">${v.slices.map((s) => `<li${s.done ? ' class="done"' : ''}><span class="b">${esc(s.title)}</span> <span class="mute">${s.done ? 'done' : ''}</span><div class="mute">${esc(s.delivers)}</div></li>`).join('')}</ol>` : '';
  const reviews = v.reviews.map((r) => `<div class="round"><div class="label">${esc(r.title)}</div><p>${esc(r.summary)}</p>
    ${r.findings.map((f) => `<div class="finding"><span class="tag tone-${f.tone}">${esc(f.tag)}${f.fate ? ` · ${esc(f.fate)}` : ''}</span>${f.where ? `<code>${esc(f.where)}</code>` : ''}<p>${esc(f.problem)}</p>${f.fix ? `<p class="mute">${esc(f.fix)}</p>` : ''}</div>`).join('') || none('No findings.')}</div>`).join('');
  const shots = v.shots.map((s) => {
    const src = shotUrls.get(shotKey(s.src));
    return `<figure class="shot" data-key="s-${esc(s.src)}">${src ? `<img src="${esc(src)}" alt="${esc(s.name)}">` : none('Loading…')}<figcaption>${esc(s.name)}</figcaption></figure>`;
  }).join('');
  const questions = v.questions.map((q) => `<div class="qa"><p><span class="label">Asked</span> ${esc(q.question)}</p><p${q.answered ? '' : ' class="tone-ask"'}><span class="label">Answer</span> ${esc(q.answer)}</p></div>`).join('');
  return [
    v.reason ? `<pre class="text why">${esc(v.reason)}</pre>` : '',
    `<div class="numbers">${v.numbers.map((n) => `<div><code class="num">${esc(n.v)}</code><span class="mute">${esc(n.k)}</span></div>`).join('')}</div>`,
    section('stages', 'Where the time went', stages || none('No stage has taken time yet.')),
    criteria ? section('criteria', `Acceptance criteria${note(v.notes.criteria)}`, `<div class="list">${criteria}</div>`) : '',
    section('checks', `Checks${note(v.notes.checks)}`, chips ? `<div class="chips">${chips}</div>` : none(criteria ? 'No other checks.' : 'No checks have run yet.')),
    section('review', `Review${note(v.notes.review)}`, reviews || none('Not reviewed yet.')),
    shots ? section('screenshots', 'Screenshots', `<div class="shots">${shots}</div>`) : '',
    `<div class="folds">${[
      slices ? fold('slices', `Slices${note(`${v.slices.filter((s) => s.done).length} of ${v.slices.length}`)}`, slices) : '',
      fold('spec', 'Spec', v.spec ? pre(v.spec) : none('Helix no longer has the spec.')),
      fold('log', 'Log', v.log ? pre(v.log, ' data-log') : none(v.noLog), v.follow),
      v.tools ? fold('tools', `Tool calls${note(v.tools.summary)}`, pre(v.tools.text)) : '',
      fold('questions', `Questions${note(v.questions.length ? '' : 'none asked')}`, questions || none('It has asked nothing.')),
    ].join('')}</div>`,
  ].join('');
}

/** The panels beside a job page's main column: its pull request and its labels. */
function jobSide(v: JobPageView): string {
  const rows = (r: { k: string; v: string }[]) => r.map((x) => `<div class="kv"><span class="mute">${esc(x.k)}</span><span>${esc(x.v)}</span></div>`).join('');
  const pr = v.pr ? `<section class="panel pr"><h2>Pull request</h2>
    <div class="kv"><span>${esc(v.pr.number)}</span>${v.pr.href ? `<a class="tone-${v.pr.tone}" href="${esc(v.pr.href)}" target="_blank" rel="noopener noreferrer">${esc(v.pr.state)} ↗</a>` : `<span class="tone-${v.pr.tone}">${esc(v.pr.state)}</span>`}</div>${rows(v.pr.rows)}</section>` : '';
  const labels = v.labels.length ? `<section class="panel labels"><h2>Labels</h2>${rows(v.labels)}</section>` : '';
  // Each agent's bar is its share of the cost, in a colour by rank (a class, since the CSP allows no style attribute).
  const agents = v.agents.length ? `<section class="panel agents"><h2>Agents</h2>${v.agents.map((a, i) => `<div class="agent"><span>${esc(a.name)}</span><span class="mono mute">${esc(a.cost)}</span><svg class="bar a${Math.min(i, 3)}" aria-hidden="true"><rect width="${a.pct}%" height="100%"/></svg><span class="calls">${esc(a.calls)}</span></div>`).join('')}</section>` : '';
  const taught = v.taught.length ? `<section class="panel learn"><h2>What this run taught</h2><ul>${v.taught.map((l) => `<li>${esc(l.text)} <span class="mute">${esc(l.state)}</span></li>`).join('')}</ul><span class="mute note">Lessons from the retro that cite this job. One is kept only when you accept it.</span></section>` : '';
  return pr || agents || taught || labels ? `<aside class="side">${pr}${agents}${taught}${labels}</aside>` : '';
}

function jobMain(id: number | string, now: number, local: boolean): string {
  const notice = jobNotice(id, readToken(storage) !== null, state.jobStatus, local);
  const v = state.job?.job.id === id ? jobView(state.job, now, local, state.display?.closed?.find((c) => c.job === id)) : undefined;
  const fixes = v?.facts.find((f) => f.k === 'fixes');
  const lead = v && !notice ? `<div class="tag-row"><span class="tag tone-${v.tag.tone}">${esc(v.tag.text)}</span><span class="mute">${ref(id) ? `${ref(id)} · ` : ''}${esc(v.line)}${fixes?.page ? ` · fixes <a href="${esc(fixes.page)}">${esc(fixes.v)}</a>` : ''}</span></div>` : '';
  const scope = `<div class="scope"><div><h1>${esc(v?.title ?? `Job ${ref(id) || id}`)}</h1>${lead}</div></div>`;
  const body = notice ? `<div class="none boxed">${esc(notice.text)}</div>${notice.signIn ? signIn : ''}` : v ? jobSections(v) : '';
  const trail = v && !notice ? `<nav class="crumb" aria-label="Trail"><a href="/jobs">Jobs</a> / ${esc(v.trail.project)} / <code>${esc(v.trail.job)}</code></nav>` : back('/jobs', 'Jobs');
  return `<main class="main">${trail}${scope}${body}</main>${v && !notice ? jobSide(v) : ''}`;
}

function peopleList(local: boolean): string {
  const notice = peopleNotice(readToken(storage) !== null, state.peopleStatus, local);
  if (notice) return `<div class="none boxed">${esc(notice)}</div>${local ? '' : signIn}`;
  if (!state.people) return '';
  const rows = peopleView(state.people).rows.map((p) => `<tr data-key="u-${esc(p.name)}">
    <td><a href="${esc(p.page)}">${esc(p.name)}</a></td><td>${esc(p.github)}</td><td>${esc(p.joined)}</td>
    <td class="num">${p.jobs}</td><td class="num">${p.prs}</td><td class="num">${esc(p.spent)}</td><td>${esc(p.last)}</td></tr>`).join('');
  return rows ? `<table class="people"><thead><tr><th>Person</th><th>GitHub</th><th>Joined</th><th class="num">Jobs</th><th class="num">PRs opened</th><th class="num">Spent</th><th>Last activity</th></tr></thead><tbody>${rows}</tbody></table>` : none('Nobody has joined this Helix yet.');
}

function personSections(name: string, local: boolean): string {
  const notice = personNotice(name, readToken(storage) !== null, state.personStatus, local);
  if (notice) return `<div class="none boxed">${esc(notice)}</div>${readToken(storage) || local ? '' : signIn}`;
  if (state.person?.name !== name) return '';
  const v = personView(state.person, state.older);
  const facts = `<div class="facts">${v.facts.map((f) => `<div><span class="mute">${esc(f.k)}</span> ${esc(f.v)}</div>`).join('')}</div>`;
  const jobs = v.jobs.map((j) => `<div class="done-row" data-key="j-${j.id}">
    ${j.href ? `<a class="tag" href="${esc(j.href)}" target="_blank" rel="noopener noreferrer">${esc(j.tag)}</a>` : `<span class="tag">${esc(j.tag)}</span>`}
    <a class="title" href="${esc(j.page)}">${esc(j.title)}</a><span class="by">#${j.id} · ${esc(j.repo)} · ${esc(j.submitted)}</span></div>`).join('');
  const activity = v.activity.map((a, i) => `<div class="done-row" data-key="a-${i}"><span class="by">${esc(a.when)}</span>${a.page ? `<a class="title" href="${esc(a.page)}">${esc(a.text)}</a>` : `<span class="title">${esc(a.text)}</span>`}${a.note ? `<span class="reason">${esc(a.note)}</span>` : ''}</div>`).join('');
  return [
    v.left ? `<div class="none boxed">${esc(v.left)}</div>` : '', facts,
    section('jobs', 'Jobs', (jobs || none('No job yet.')) + (v.more ? '<button type="button" class="more" data-more>Show more</button>' : '')),
    section('activity', 'Activity', activity || none('Nothing kept yet.')),
  ].join('');
}

const peopleMain = (local: boolean, name?: string) => `<main class="main">${name ? back('/people', 'People') : ''}
  <div class="scope"><div><h1>${esc(name ?? 'People')}</h1></div></div>
  ${name ? personSections(name, local) : peopleList(local)}
</main>`;

/** A select that reloads the page with its filter in the address. */
const pick = (name: 'result' | 'project' | 'person', label: string, values: readonly string[], on: string) => `<label class="filter"><span class="mute">${label}</span><select data-filter="${name}">${values.map((v) => `<option value="${esc(v === 'all' || v === '' ? '' : v)}"${v === on || (v === 'all' && !on) ? ' selected' : ''}>${esc(v || 'all')}</option>`).join('')}</select></label>`;

function jobsMain(local: boolean): string {
  const notice = jobsNotice(readToken(storage) !== null, state.listStatus, local);
  const f = filterOf(location.search);
  // The people it offers are those on the overview's newest jobs, and the one in the address.
  const names = ['', ...new Set([...state.display!.jobs.map((j) => j.person), f.person].filter(Boolean))].sort();
  const bar = notice ? '' : `<div class="filters"><nav class="segmented" aria-label="Result">${RESULTS.map((r) => `<a href="/jobs${queryOf({ ...f, result: r })}"${r === f.result ? ' aria-current="true"' : ''}>${r === 'all' ? 'All' : r[0]!.toUpperCase() + r.slice(1)}</a>`).join('')}</nav>${[
    pick('project', 'Project', ['', ...new Set([...state.display!.repos.map((r) => r.name), f.project].filter(Boolean))], f.project),
    ...(local ? [] : [pick('person', 'Person', names, f.person)]),
  ].join('')}</div>`;
  const now = (state.offline && state.heard ? state.heard.getTime() : Date.now()) + state.skew;
  const lv = state.list ? jobListView({ ...state.list, jobs: [...state.list.jobs, ...state.listOlder] }, local, now) : undefined;
  const t = lv?.totals;
  const sum = t ? `<div class="sum"><div><b>${t.jobs}</b><span class="mute">jobs</span></div><div><b>${t.merged}</b><span class="mute">merged · ${t.mergedShare}</span></div><div><b>${t.failed}</b><span class="mute">failed</span></div><div><b class="mono">${t.spent}</b><span class="mute">spent</span></div><div><b class="mono">${t.perMerged}</b><span class="mute">per merged PR</span></div></div>` : '';
  const tr = (r: JobRow) => `<div class="tr" data-key="j-${r.id}">
    ${r.href ? `<a class="tag tone-${r.tone}" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${esc(r.tag)}</a>` : `<span class="tag tone-${r.tone}">${esc(r.tag)}</span>`}
    <span class="job"><a class="title" href="${esc(r.page)}">${esc(r.title)}</a>${r.why ? `<span class="why tone-${r.tone === 'fail' || r.tone === 'ask' ? r.tone : 'mute'}">${esc(r.why)}</span>` : ''}</span>
    <span class="mute">${esc(r.repo)}</span>${local ? '' : `<span class="mute">${who(r)}</span>`}
    <span class="n">${esc(r.took)}</span><span class="n">${esc(r.fixes)}</span><span class="n cost">${esc(r.cost)}</span><span class="n">${esc(r.toMerge)}</span>
  </div>`;
  const table = lv ? `<div class="tbl${local ? ' local' : ''}"><div class="tr th"><span>Result</span><span>Job</span><span>Project</span>${local ? '' : '<span>Person</span>'}<span class="n">Took</span><span class="n">Fix rounds</span><span class="n cost">Cost</span><span class="n">To merge</span></div>${
    lv.rows.map((r, i) => `${lv.days.filter((d) => d.at === i).map((d) => `<div class="day">${esc(d.heading)}</div>`).join('')}${tr(r)}`).join('')}</div>` : '';
  const body = notice ? `<div class="none boxed">${esc(notice)}</div>${local ? '' : signIn}` : state.list
    ? `${sum}${lv!.rows.length ? table : none('No job matches.')}${state.listMore ? '<button type="button" class="more" data-more>Show more</button>' : ''}` : '';
  return `<main class="main"><div class="scope"><div><h1>Jobs</h1></div></div>${bar}${body}</main>`;
}

const hn = (text: string) => (text ? ` <span class="count">${esc(text)}</span>` : '');
const tone = (t: string) => (t === 'good' ? ' good' : t === 'bad' ? ' bad' : '');

function insightsMain(local: boolean, now: number): string {
  const notice = insightsNotice(readToken(storage) !== null, state.insightsStatus, local);
  const title = '<div><h1>Insights</h1><p class="last">Is the factory getting better? Last 30 days against the 30 before.</p></div>';
  const head = `<div class="scope">${title}</div>`;
  if (notice) return `<main class="main">${head}<div class="none boxed">${esc(notice)}</div>${local ? '' : signIn}</main>`;
  if (!state.insights) return '';
  const v = insightsView(state.insights, now);
  const scopes = `<nav class="segmented" aria-label="Scope" data-key="scopes">${v.scopes.map((s) => `<a href="${esc(s.href)}"${s.on ? ' aria-current="true"' : ''}>${esc(s.name)}</a>`).join('')}</nav>`;
  const top = `<div class="scope">${title}${scopes}</div>`;
  if (v.none) return `<main class="main">${top}${none('No job ended in the last 30 days.')}</main>`;
  const tiles = `<div class="tiles">${v.tiles.map((t) => `<div class="tile" data-key="t-${esc(t.label)}"><span class="mute">${esc(t.label)}</span><b>${esc(t.value)}</b><span class="note${t.change ? tone(t.change.tone) : ''}">${t.change ? `${esc(t.change.text)} · ` : ''}${esc(t.note)}</span></div>`).join('')}</div>`;
  const classes = `<div class="scroll"><table class="grid"><thead><tr><th>Class</th><th class="num">Jobs</th><th class="num">Merged</th><th class="num">First pass</th><th class="num">$ / merged</th></tr></thead><tbody>${v.classes.map((c) => `<tr data-key="c-${esc(c.name)}"><td>${esc(c.name)}</td><td class="num">${esc(c.jobs)}</td><td class="num">${esc(c.merged)}</td><td class="num">${esc(c.firstPass)}</td><td class="num">${esc(c.perMerged)}</td></tr>`).join('')}</tbody></table></div>`;
  const causes = v.causes.map((c) => `<div class="cause" data-key="k-${esc(c.label)}"><span>${esc(c.label)}</span><svg class="bar tone-${c.tone}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="6" class="rail"></rect><rect width="${c.pct}" height="6" class="fill"></rect></svg><span class="mono mute">${c.count}</span></div>`).join('');
  const agents = `<div class="scroll"><table class="grid"><thead><tr><th>Role</th><th class="num">Tier</th><th class="num">Share of cost</th><th class="num">Tool calls</th><th class="num">Tool errors</th></tr></thead><tbody>${v.agents.map((a) => `<tr data-key="a-${esc(a.role)}-${esc(a.tier)}"><td>${esc(a.role)}</td><td class="num">${esc(a.tier)}</td><td class="num">${esc(a.cost)}</td><td class="num">${esc(a.calls)}</td><td class="num">${esc(a.failed)}</td></tr>`).join('')}</tbody></table></div>${v.findings ? `<p class="note">Review findings acted on: ${esc(v.findings)}.</p>` : ''}`;
  const flaky = v.flaky.map((f) => `<div class="li" data-key="f-${esc(f.name)}-${esc(f.where)}"><span class="pill p-plain">${esc(f.times)}</span><span class="tt mono">${esc(f.name)}</span><span class="r">${esc(f.where)}</span></div>`).join('');
  const proposed = v.proposed.map((l) => `<div class="lesson" data-key="lp-${l.id}"><span><span class="scope-chip">${esc(l.scope)}</span>${esc(l.text)}</span><span class="src">${esc(l.source)}</span><span class="cmd">${esc(l.command)}</span></div>`).join('');
  const kept = v.kept.map((l) => `<div class="li" data-key="lk-${l.id}"><span class="pill ${l.used ? 'p-open' : 'p-plain'}">${esc(l.uses)}</span><span class="tt">${esc(l.text)}</span><span class="r">${esc(l.where)}</span></div>`).join('');
  return `<main class="main">${top}${tiles}
    <div class="two">${section('classes', 'By task class', classes)}${section('causes', `Why jobs did not deliver${hn(v.causeCount)}`, causes ? `<div>${causes}<p class="note">Each job's cause is set by script from where it stopped.</p></div>` : none('Every job delivered.'))}</div>
    <div class="two">${section('agents', 'Agents', agents)}${section('flaky', `Flaky checks${hn('failed, then passed on the same code')}`, flaky || none('No flaky check.'))}</div>
    ${section('lessons', `Proposed lessons${hn('from the weekly retro · each needs your yes')}`, proposed || none('No lesson is waiting for a yes.'))}
    ${section('kept', `Kept lessons${hn(v.kept.length ? String(v.kept.length) : '')}`, kept || none('No lesson is kept.'))}</main>`;
}

function page(): string {
  // While Helix is out of reach the clock it was last read at stands still, and so does every count of time.
  const now = (state.offline && state.heard ? state.heard.getTime() : Date.now()) + state.skew;
  const v = state.display ? view(state.display, picked(), now) : undefined;
  // A job page waits for the display: whether it needs a sign-in depends on the source it answers.
  const body = at.page === 'job' ? (state.display ? jobMain(at.id, now, state.display.local === true) : '') : at.page === 'jobs' ? (state.display ? jobsMain(state.display.local === true) : '') : at.page === 'people' ? (state.display ? peopleMain(state.display.local === true, at.name) : '') : at.page === 'insights' ? (state.display ? insightsMain(state.display.local === true, now) : '') : v ? `${main(v)}${nav(v)}` : '';
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
  // A folded part is opened and closed by the person, never by a redraw.
  const kept = (n: string) => n === 'open' && from.nodeName === 'DETAILS';
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name) && !kept(a.name)) from.removeAttribute(a.name);
  for (const a of [...to.attributes]) if (!kept(a.name) && from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
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

/** The Jobs page's data for the address's filters: the newest thirty, or with `before` the thirty older than that `submitted` time. A token Helix refuses is forgotten. */
async function readJobs(before?: string): Promise<void> {
  const token = readToken(storage);
  const f = filterOf(location.search);
  const query = new URLSearchParams({ ...(f.result !== 'all' ? { result: f.result } : {}), ...(f.project ? { project: f.project } : {}), ...(f.person ? { person: f.person } : {}), ...(before ? { before } : {}) });
  const res = await fetch(`/job-list?${query}`, { cache: 'no-store', headers: auth(token) });
  if (before === undefined) state.listStatus = res.status === 401 && !token ? undefined : res.status;
  if (res.status === 401 && token) forgetToken(storage);
  if (!res.ok) return;
  const data = (await res.json()) as JobListPage;
  if (before === undefined) {
    // Once older jobs were read, a refresh must not leave a job between the two lists.
    const oldest = data.jobs.at(-1)?.submitted ?? '';
    if (state.list && state.listOlder.length) state.listOlder = [...state.list.jobs, ...state.listOlder].filter((j) => j.submitted < oldest);
    else state.listMore = data.more;
    state.list = data;
  } else {
    state.listOlder = [...state.listOlder, ...data.jobs];
    state.listMore = data.more;
  }
}

/** The Insights page's data for the address's scope, with the token as it is kept now; a token Helix refuses is forgotten. */
async function readInsights(): Promise<void> {
  const token = readToken(storage);
  const res = await fetch(`/insights-data?scope=${encodeURIComponent(scopeOf(location.search))}`, { cache: 'no-store', headers: auth(token) });
  state.insightsStatus = res.status === 401 && !token ? undefined : res.status;
  if (res.status === 401 && token) forgetToken(storage);
  if (res.ok) state.insights = (await res.json()) as InsightsPage;
}

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
    const [res] = await Promise.all([fetch('/display', { cache: 'no-store' }), at.page === 'job' ? readJob(at.id) : at.page === 'jobs' ? readJobs() : at.page === 'insights' ? readInsights() : at.page === 'people' ? (at.name ? readPerson(at.name) : readPeople()) : undefined]);
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
  Object.assign(state, { jobStatus: undefined, listStatus: undefined, peopleStatus: undefined, personStatus: undefined, insightsStatus: undefined });
  void poll();
});

// A filter chosen goes into the address and the page is read again, so the filtered list can be reloaded or shared.
root.addEventListener('change', (event) => {
  const select = (event.target as Element).closest('[data-filter]') as HTMLSelectElement | null;
  if (!select) return;
  const f = { ...filterOf(location.search), [select.dataset.filter!]: select.value || (select.dataset.filter === 'result' ? 'all' : '') };
  location.assign(`/jobs${queryOf(f)}`);
});

root.addEventListener('click', (event) => {
  if ((event.target as Element).closest('[data-sign-out]')) {
    forgetToken(storage);
    forgetShots();
    Object.assign(state, { job: undefined, jobStatus: undefined, list: undefined, listStatus: undefined, listOlder: [], listMore: false, people: undefined, peopleStatus: undefined, person: undefined, personStatus: undefined, older: { jobs: [], more: false }, insights: undefined, insightsStatus: undefined });
    draw();
    return;
  }
  if ((event.target as Element).closest('[data-more]') && at.page === 'jobs' && state.list) {
    void readJobs([...state.list.jobs, ...state.listOlder].at(-1)?.submitted).then(draw);
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
// helix.css holds every animation still while the tab is hidden.
document.addEventListener('visibilitychange', () => document.documentElement.toggleAttribute('data-hidden', document.hidden));
window.setInterval(draw, 1000);
void poll();
