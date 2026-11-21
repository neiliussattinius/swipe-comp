// Swipe Comp: DOM wiring. Connects to LUNA, follows the open session, draws one track's takes
// stacked with the comp above them, and turns swipes into comp edits through logic.js.
// Every listener returned by onChange is kept so it can be released when things change.

const $ = (id) => document.getElementById(id);
const L = AddOnLogic;
const GUTTER = 150, MARKS_H = 18, BAR_H = 22, COMP_H = 72, SIL_H = 26, LANE_H = 60, CLIP_HEAD = 15;
const RULER_H = MARKS_H + BAR_H;    // LUNA's markers, then the bar numbers
const SIL_TOP = RULER_H + COMP_H;   // the Silence strip, pinned under the comp row

// Key names the way this computer says them: Cmd and Option on a Mac, Ctrl and Alt on Windows.
// (The keys themselves already work on both: the handlers take metaKey or ctrlKey, and altKey.)
const MAC = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
const keyNames = (s) => (MAC ? s : s.replace(/\bCmd\b/g, 'Ctrl').replace(/\bOption\b/g, 'Alt'));
if (!MAC) {
  for (const el of document.querySelectorAll('[title]')) el.title = keyNames(el.title);
  const foot = document.querySelector('footer');
  if (foot) foot.textContent = keyNames(foot.textContent);
}

let luna, session, track, compLane;
let takes = [];
let segments = [];      // the saved comp list
let pending;            // a list being built, shown until LUNA has it
let preview;            // { list, rect? } while dragging: the comp as it would be, and a swipe's outline
let held;               // { next, count }: a change waiting because the comp holds clips the page did not place
let drag;
let view = { start: 0, end: 1 };
let scene;              // waveform columns gathered for the current view
let busy = false, rebindLater = false;
let sessionOffs = [], trackOffs = [], clipOffs = [];
const cache = new Luna.Waveforms();
let gatherTicket = 0, gatherFrame = 0, paintFrame = 0, headFrame = 0;

const release = (list) => { for (const u of list.splice(0)) { try { u(); } catch { /* already gone */ } } };

function setStatus(text, kind = '') {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
  el.className = kind;
}

function summary() {
  if (!session) return 'No session open';
  if (!track) return session.name.value ?? '';
  const n = segments.length;
  const base = `${session.name.value} · ${track.name.value}: ${takes.length} take${takes.length === 1 ? '' : 's'} · comp ${n ? `${n} section${n === 1 ? '' : 's'}` : 'empty'}`;
  const out = leftOutNote();
  if (!groupActive()) return out ? `${base} · ${out}` : base;
  const gaps = groupGaps();
  return `${base} · with ${mates.length} grouped track${mates.length === 1 ? '' : 's'}${gaps.length ? ` (${gaps.join('; ')})` : ''}${out ? ` · ${out}` : ''}`;
}

/** Grouped tracks left out because their take count differs, as "left out of the group comp: Amp has 3 takes, this track 4". */
function leftOutNote() {
  if (!groupWanted || !leftOut.length) return '';
  const n = (c) => `${c} take${c === 1 ? '' : 's'}`;
  return `left out of the group comp (grouped tracks need the same number of takes): ${leftOut.map((m) => `${m.track.name.value} has ${n(m.count)}`).join(', ')}, this track ${leadTakeCount}`;
}

// ── comping an edit group ───────────────────────────────────────────────────────────────
// When the track is in a LUNA edit group that is switched on, the page can comp the group's
// tracks together, as Logic does with a group's Editing on: the same sections on every track,
// each from its own matching take. `mates` are the group's other comp-able tracks.
let mates = [];          // [{ track, lane, map }]: map = this track's take id -> the mate's take id
let leftOut = [];        // [{ track, count }]: grouped tracks with a different number of takes (Logic's rule)
let leadTakeCount = 0;
let groupOffs = [];
let groupWanted = true;  // the header's "Comp the group" box
let groupNamesShown = [];
const groupActive = () => groupWanted && mates.length > 0;

/** Mates with no matching take for a take the comp uses, as "BGV 2: no match for T5". */
function groupGaps() {
  const used = [...new Set(segments.map((s) => s.take))];
  return mates.flatMap((m) => {
    const missing = used.filter((id) => !m.map.has(id)).map((id) => nameOf(id));
    return missing.length ? [`${m.track.name.value}: no take matching ${missing.join(', ')}`] : [];
  });
}

async function refreshGroup() {
  const forTrack = track;
  if (!session || !forTrack) { mates = []; leftOut = []; paintGroup(); return; }
  const found = (await L.groupMates(session, forTrack))
    .filter((t) => t.trackType.value === 'audio');
  for (const t of found) await Promise.all(L.playlistsOf(session, t).map((p) => p.clips.load()));
  const names = found.length ? await L.groupNames(session, forTrack) : [];
  if (forTrack !== track) return;   // the track changed while LUNA answered
  // Logic's rule: grouped tracks comp together when they have the same number of takes.
  leadTakeCount = L.recordedTakes(session, forTrack).length;
  const counted = found.map((t) => ({ track: t, count: L.recordedTakes(session, t).length }));
  leftOut = counted.filter((m) => m.count !== leadTakeCount);
  mates = counted.filter((m) => m.count === leadTakeCount)
    .map(({ track: t }) => ({ track: t, lane: L.compLaneOf(session, t), map: L.matchTakes(session, forTrack, t) }));
  groupNamesShown = names;
  release(groupOffs);
  for (const m of mates) groupOffs.push(m.track.playlistUid.onChange(scheduleNotice));
  paintGroup();
  if (!busy) setStatus(summary());
  paintNotice();
}
let groupTimer;
function scheduleGroup() {
  clearTimeout(groupTimer);
  groupTimer = setTimeout(() => void refreshGroup(), 250);
}
function paintGroup() {
  const box = $('groupBox'), label = $('groupLabel');
  box.hidden = mates.length === 0;
  $('groupOn').checked = groupWanted;
  const name = groupNamesShown.length ? groupNamesShown.join(' + ') : 'edit group';
  label.textContent = `Comp the group (${name}: ${mates.length + 1} tracks)`;
  box.title = `Comp ${[track, ...mates.map((m) => m.track)].map((t) => t?.name.value).join(', ')} together: the same sections on each, from each track's matching take, as one undo step.`;
}
$('groupOn').onchange = () => { groupWanted = $('groupOn').checked; setStatus(summary()); paintNotice(); };

/** Play `lane` on this track and, comping a group, the matching take (or comp) on each mate. */
async function playEverywhere(lane) {
  const pairs = [{ track, lane }];
  if (groupActive()) {
    for (const m of mates) {
      const other = lane === compLane ? m.lane : session.playlists.byId(m.map.get(lane.id));
      if (other) pairs.push({ track: m.track, lane: other });
    }
  }
  const todo = pairs.filter((p) => session.playlistFor(p.track) !== p.lane);
  if (todo.length <= 1) { for (const p of todo) await L.showPlaylist(session, p.track.id, p.lane.version.value); return; }
  await session.transaction(lane === compLane ? 'Hear the comp' : 'Hear a take', async () => {
    for (const p of todo) await L.showPlaylist(session, p.track.id, p.lane.version.value);
  });
}

// ── geometry ───────────────────────────────────────────────────────────────────────────

const widthCss = () => $('top').clientWidth;
function x(tick) {
  return GUTTER + ((tick - view.start) / (view.end - view.start)) * Math.max(1, widthCss() - GUTTER);
}
function tickAt(px) {
  return view.start + ((px - GUTTER) / Math.max(1, widthCss() - GUTTER)) * (view.end - view.start);
}

function sizeCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1, cssW = canvas.parentElement.clientWidth;
  canvas.style.height = `${cssH}px`;
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// A take's colour follows the take (its place in recording order), not its row, so colours
// stay put when a new take is recorded and lands at the top.
let colorIndex = new Map();
function hue(takeId, alpha = 1) {
  const i = colorIndex.get(takeId) ?? -1;
  if (i < 0) return `hsla(0, 0%, 60%, ${alpha})`;
  return `hsla(${(i * 137.508) % 360}, 62%, 62%, ${alpha})`;
}
const nameOf = (takeId) => session?.playlists.byId(takeId)?.name.value ?? '?';

// Snap uses LUNA's own Grid setting and switch (the edit context's `grid`, its modifier and
// `grid_enable`), so the page snaps where LUNA's Timeline would.
function lunaGrid() {
  const c = session?.context;
  if (!c) return { on: false, label: '' };
  const grid = c.grid.value, mod = c.property('grid_modifier').value, adaptive = c.property('grid_adaptive').value === true;
  return { on: c.gridEnable.value === true, grid, mod, adaptive, label: adaptive ? 'adaptive' : L.gridLabel(grid, mod) };
}
const pxPerTick = () => Math.max(1, widthCss() - GUTTER) / Math.max(1, view.end - view.start);
/** Ticks between grid lines in a bar of `barTicks`; an adaptive grid follows the zoom, as LUNA's does. */
function gridStepAt(g, barTicks) {
  if (!g.adaptive) return L.gridStep(g.grid, g.mod, barTicks);
  for (const div of [32, 16, 8, 4]) if ((Luna.WHOLE_NOTE / div) * pxPerTick() >= 12) return Luna.WHOLE_NOTE / div;
  return barTicks;
}
function snapTick(tick) {
  const g = lunaGrid();
  if (!g.on || !session.musical.timeline.tempoLoaded) return Math.round(tick);
  const t = session.musical.timeline, bar = t.barBeat(Math.max(0, tick)).bar, a = t.tickAt({ bar }), b = t.tickAt({ bar: bar + 1 });
  return L.snapInBar(tick, a, b, gridStepAt(g, b - a));
}
function paintSnap() {
  const g = lunaGrid(), btn = $('snap'), text = g.label ? `Snap ${g.label}` : 'Snap';
  if (btn.textContent !== text) btn.textContent = text;
  btn.classList.toggle('on', !!g.on);
  const title = `Snap to LUNA's grid (${g.label || 'its Grid setting'}; change it in LUNA's Timeline). This is LUNA's own Grid switch, so it turns snapping on or off there too.`;
  if (btn.title !== title) btn.title = title;
}
$('snap').onclick = () => { if (session) void session.context.gridEnable.set(session.context.gridEnable.value !== true); };

let fadeShownFor;   // the track whose saved crossfade length the box was last set to
function fadeMs() {
  const v = Number($('fade').value);
  return Number.isFinite(v) ? Math.min(250, Math.max(0, v)) : 10;
}

// ── view ───────────────────────────────────────────────────────────────────────────────

function fit() {
  const e = L.extent(takes);
  view = e ? { start: Math.max(0, e.start - Luna.QUARTER_NOTE), end: e.stop + Luna.QUARTER_NOTE } : { start: 0, end: Luna.WHOLE_NOTE * 8 };
  scheduleGather();
  schedulePaint();
}

function zoom(factor, around) {
  const c = around ?? (view.start + view.end) / 2, span0 = view.end - view.start;
  const span = Math.max(Luna.QUARTER_NOTE, span0 * factor), f = (c - view.start) / span0;
  const start = Math.max(0, c - f * span);
  view = { start, end: start + span };
  scheduleGather();
  schedulePaint();
}

function pan(ticks) {
  const span = view.end - view.start, start = Math.max(0, view.start + ticks);
  view = { start, end: start + span };
  scheduleGather();
  schedulePaint();
}

// ── gathering waveforms (async) and painting (sync) ───────────────────────────────────

function scheduleGather() {
  if (gatherFrame) return;
  gatherFrame = requestAnimationFrame(() => { gatherFrame = 0; void gather(); });
}

async function gather() {
  const ticket = ++gatherTicket;
  if (!session || !track) { scene = undefined; schedulePaint(); return; }
  const t = session.musical.timeline;
  if (!t.tempoLoaded) return;
  const w = Math.max(1, widthCss() - GUTTER);
  const kind = Luna.kindForScale(((t.seconds(view.end) - t.seconds(view.start)) * 1e9) / w);
  const zoomGain = session.context.waveformZoom.value ?? 1;
  const lanes = new Map();
  for (const lane of compLane ? [compLane, ...takes] : takes) {
    const out = [];
    for (const piece of L.piecesOf(lane)) {
      if (piece.stop <= view.start || piece.start >= view.end) continue;
      const clip = piece.clip, a = Math.max(piece.start, view.start), b = Math.min(piece.stop, view.end);
      const audio = session.sources && Luna.clipAudio(clip, session.sources);
      if (!audio) { out.push({ start: a, stop: b, outline: true }); continue; }
      const px0 = Math.floor(x(a)), px1 = Math.ceil(x(b));
      const from = Math.max(audio.startNs, Luna.audioNsAtTick(t, clip, audio, a) - Luna.OVERVIEW_PAIR_NS);
      const to = Math.min(audio.stopNs, Luna.audioNsAtTick(t, clip, audio, b) + Luna.OVERVIEW_PAIR_NS);
      let range;
      try { range = await cache.range(audio.source, from, Math.max(from, to), kind); } catch { range = undefined; }
      if (ticket !== gatherTicket) return;
      if (!range?.count) { out.push({ start: a, stop: b, outline: true }); continue; }
      const cols = Luna.waveformColumns(range, Math.max(0, px1 - px0),
        (i) => Luna.audioNsAtTick(t, clip, audio, tickAt(px0 + i + 0.5)),
        { gain: zoomGain * 10 ** ((clip.gain.value ?? 0) / 20) });
      out.push({ start: a, stop: b, px0, cols });
    }
    lanes.set(lane.id, out);
  }
  if (ticket !== gatherTicket) return;
  scene = { lanes };
  paint();
}

function schedulePaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => { paintFrame = 0; paint(); });
}

function shownSegments() {
  return preview?.list ?? pending ?? segments;
}

function barLines() {
  const t = session.musical.timeline, out = [];
  if (!t.tempoLoaded) return out;
  const first = t.barBeat(Math.max(0, view.start)).bar, last = t.barBeat(view.end).bar + 1;
  for (let bar = first; bar <= last; bar++) {
    const bx = x(t.tickAt({ bar }));
    if (bx >= GUTTER && bx <= widthCss()) out.push({ bar, x: bx });
  }
  return out;
}

function drawPiece(ctx, p, top, h, color) {
  if (p.outline) {
    const a = Math.max(GUTTER, x(p.start)), b = Math.min(widthCss(), x(p.stop));
    ctx.strokeStyle = color;
    ctx.strokeRect(a + 0.5, top + 0.5, Math.max(1, b - a - 1), h - 1);
    return;
  }
  const lanes = Luna.waveformLanes(p.cols.channels.length, top, h, 0);
  ctx.fillStyle = color;
  ctx.beginPath();
  p.cols.channels.forEach((ch, c) => Luna.traceWaveform(ctx, ch, lanes[c], p.px0));
  ctx.fill();
}

/** `text` cut to fit `max` pixels, with an ellipsis. */
function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

// ── LUNA's look ─────────────────────────────────────────────────────────────────────────
// Drawn to sit beside LUNA's own Timeline: dark lanes, clips as light blocks with a name strip
// and a dark waveform, grid lines over everything. A take's clips are a light shade of the
// take's own colour. Audio the comp doesn't use is greyed, as LUNA greys a muted clip, so it
// can still be swiped.
const UI = {
  lane: '#272727', sep: '#121212', head: '#383838', headOn: '#4a4a4a', headLine: '#232323',
  name: '#c9c9c9', nameOn: '#ffffff', ruler: '#1e1e1e',
  grid: ['rgba(150, 150, 150, 0.42)', 'rgba(150, 150, 150, 0.22)', 'rgba(150, 150, 150, 0.12)'],   // bar, beat, finer
};
const GHOST = { body: '#3a3d41', head: '#42464b', edge: '#2b2e32', wave: '#737a82', text: '#a7adb3' };
function clipColors(takeId) {
  const i = colorIndex.get(takeId) ?? -1;
  if (i < 0) return { body: '#b8b8b8', head: '#c8c8c8', edge: '#6e6e6e', wave: '#1a1a1a', text: '#141414' };
  const h = (i * 137.508) % 360;
  return { body: `hsl(${h}, 46%, 70%)`, head: `hsl(${h}, 50%, 78%)`, edge: `hsl(${h}, 28%, 36%)`, wave: `hsl(${h}, 40%, 14%)`, text: `hsl(${h}, 45%, 13%)` };
}

/** A clip as LUNA draws one, from tick a to b: a name strip, the waveform below it, a darker edge. */
function drawClip(ctx, a, b, top, h, c, name, pieces) {
  const xa = x(a), xb = x(b), l = Math.max(GUTTER, xa), r = Math.min(widthCss(), xb);
  if (r - l < 0.5) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(l, top, r - l, h);
  ctx.clip();
  ctx.fillStyle = c.body;
  ctx.fillRect(l, top, r - l, h);
  ctx.fillStyle = c.head;
  ctx.fillRect(l, top, r - l, CLIP_HEAD);
  for (const p of pieces) drawPiece(ctx, p, top + CLIP_HEAD + 2, h - CLIP_HEAD - 4, c.wave);
  if (name && r - l > 16) {
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.text;
    ctx.fillText(fitText(ctx, name, r - l - 8), l + 4, top + CLIP_HEAD / 2 + 0.5);
  }
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(xa) + 0.5, top + 0.5, Math.max(1, Math.round(xb) - Math.round(xa) - 1), h - 1);
  ctx.restore();
}

/**
 * Grid lines in view: { x, level } with level 0 for bars, 1 for beats, 2 for LUNA's grid
 * where it is finer than a beat. Lines too close together to read are left out, as LUNA does.
 */
function gridLines() {
  const t = session.musical.timeline, out = [], W = widthCss(), ppt = pxPerTick(), g = lunaGrid();
  if (!t.tempoLoaded) return out;
  const first = t.barBeat(Math.max(0, view.start)).bar, last = t.barBeat(view.end).bar;
  if (last - first > 2000) return out;
  for (let bar = first; bar <= last; bar++) {
    const a = t.tickAt({ bar }), b = t.tickAt({ bar: bar + 1 });
    out.push({ x: x(a), level: 0 });
    const beats = [];
    for (let beat = 2; beat <= 32; beat++) {
      const bt = t.tickAt({ bar, beat });
      if (bt >= b - 1) break;
      beats.push(bt);
    }
    if (beats.length && (beats[0] - a) * ppt >= 6) for (const bt of beats) out.push({ x: x(bt), level: 1 });
    const step = gridStepAt(g, b - a);
    if (step && step * ppt >= 7) {
      for (let k = 1; a + k * step < b - 1; k++) {
        const tk = a + k * step;
        if (!beats.some((bt) => Math.abs(bt - tk) < 1)) out.push({ x: x(tk), level: 2 });
      }
    }
  }
  return out.filter((l) => l.x >= GUTTER && l.x <= W);
}
function drawGrid(ctx, lines, top, h) {
  for (const l of lines) { ctx.fillStyle = UI.grid[l.level]; ctx.fillRect(Math.round(l.x), top, 1, h); }
}

/** A row's header, as LUNA's track headers: its colour down the left edge, an audio icon, the name. */
function label(ctx, text, top, h, playing, color) {
  ctx.fillStyle = playing ? UI.headOn : UI.head;
  ctx.fillRect(0, top, GUTTER, h);
  ctx.fillStyle = color;
  ctx.fillRect(0, top, 6, h);
  ctx.fillStyle = playing ? '#e6e6e6' : '#9a9a9a';
  [3, 7, 11, 6, 3].forEach((bh, i) => ctx.fillRect(13 + i * 3, top + 12 - bh / 2, 2, bh));
  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = playing ? UI.nameOn : UI.name;
  ctx.fillText(fitText(ctx, `${playing ? '▶ ' : ''}${text}`, GUTTER - 40), 32, top + 12.5);
  ctx.fillStyle = UI.headLine;
  ctx.fillRect(GUTTER - 1, top, 1, h);
  ctx.fillRect(0, top + h - 1, GUTTER, 1);
}

function paint() {
  paintUndo();   // also follows `busy`: no undo in the middle of building the comp
  paintBase();
  paintTidy();
  paintSnap();
  const grid = session && track ? gridLines() : [];
  paintTop(grid);
  paintTakes(grid);
  placePlayhead();
}

function paintTop(grid) {
  const H = RULER_H + COMP_H + SIL_H, ctx = sizeCanvas($('topCanvas'), H), W = widthCss();
  ctx.clearRect(0, 0, W, H);
  if (!session || !track) return;
  const bars = barLines(), step = Math.max(1, Math.ceil(bars.length / Math.max(1, (W - GUTTER) / 56)));
  // Rulers: LUNA's markers on top, then the bars.
  ctx.fillStyle = UI.ruler;
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.fillStyle = UI.sep;
  ctx.fillRect(0, MARKS_H, W, 1);
  ctx.fillStyle = '#3c3c3c';
  for (const l of grid) if (l.level === 1) ctx.fillRect(Math.round(l.x), RULER_H - 5, 1, 5);
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  for (const { bar, x: bx } of bars) {
    const named = bar % step === 0;
    ctx.fillStyle = named ? '#777' : '#444';
    ctx.fillRect(Math.round(bx), MARKS_H + (named ? 4 : 12), 1, BAR_H - (named ? 4 : 12));
    if (named) { ctx.fillStyle = '#b5b5b5'; ctx.fillText(String(bar), bx + 4, MARKS_H + BAR_H / 2 + 0.5); }
  }
  paintMarkerTags(ctx, W);
  // Comp row: each section a clip from its take, as LUNA will draw the SwipeComp playlist.
  const top = RULER_H, h = COMP_H, list = shownSegments();
  ctx.fillStyle = UI.lane;
  ctx.fillRect(GUTTER, top, W - GUTTER, h);
  for (const s of list) drawClip(ctx, s.start, s.stop, top + 1, h - 2, clipColors(s.take), nameOf(s.take), scene?.lanes.get(s.take) ?? []);
  drawGrid(ctx, grid, top, h);
  // A crossfade at each seam, drawn as LUNA draws one: an X across the join.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  for (const [i, s] of list.entries()) {
    const next = list[i + 1];
    if (!next || next.start !== s.stop) continue;
    const sx = Math.round(x(s.stop)) + 0.5;
    if (sx < GUTTER || sx > W) continue;
    ctx.beginPath();
    ctx.moveTo(sx - 4, top + CLIP_HEAD + 3); ctx.lineTo(sx + 4, top + h - 4);
    ctx.moveTo(sx + 4, top + CLIP_HEAD + 3); ctx.lineTo(sx - 4, top + h - 4);
    ctx.stroke();
  }
  if (!list.length) {
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(takes.length === 1
      ? 'Drag across the parts of the take you want to keep. Or choose it in "Start from" to begin with all of it, then erase with the Silence strip.'
      : 'Drag across a take below to start the comp.', GUTTER + 12, top + h / 2);
  }
  label(ctx, compLane?.name.value ?? L.COMP_NAME, top, h, !!compLane && session.playlistFor(track) === compLane, '#F7C449');
  paintSilence(ctx, list, W);
  drawMarkerLines(ctx, MARKS_H, BAR_H + COMP_H + SIL_H);
}

// LUNA's markers: a tag in each marker's own colour on the ruler, named as in LUNA's Timeline,
// and a thin line in that colour down through the comp and the takes. A click on a tag moves
// the playhead to the marker; hovering one shows where it is and its comments.
const MARKER_DEFAULT = 0xff8a7fc4;
let markerTags = [];   // as last drawn, for clicks and hover
const markerColor = (m) => (((m.color.value ?? 0) >>> 24) ? m.color.value : MARKER_DEFAULT);
function markersInView() {
  if (!session || !track) return [];
  const W = widthCss();
  return session.markers.items
    .filter((m) => typeof m.location.value === 'number')
    .map((m) => ({ m, x: x(m.location.value) }))
    .filter((k) => k.x >= GUTTER && k.x <= W);
}
function paintMarkerTags(ctx, W) {
  ctx.font = '600 10.5px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  const marks = markersInView().map((k) => ({ ...k, want: ctx.measureText(k.m.name.value ?? '').width + 10 }));
  markerTags = L.layoutTags(marks, W);
  const top = 2, h = MARKS_H - 4;
  for (const t of markerTags) {
    const color = markerColor(t.m), xa = Math.round(t.x);
    ctx.fillStyle = L.argbCss(color);
    ctx.fillRect(xa, top, t.w, h);
    ctx.fillStyle = L.argbCss(color, 1, 0.5);
    ctx.fillRect(xa, top, 1, MARKS_H - top);   // the marker's exact spot is the tag's left edge
    if (t.w > 14) {
      ctx.fillStyle = L.textOn(color);
      ctx.fillText(fitText(ctx, t.m.name.value ?? '', t.w - 8), xa + 4, top + h / 2 + 0.5);
    }
  }
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#7a7a7a';
  ctx.fillText('Markers', 10, MARKS_H / 2 + 0.5);
}
function drawMarkerLines(ctx, top, h) {
  for (const { m, x: mx } of markersInView()) {
    ctx.fillStyle = L.argbCss(markerColor(m), 0.95, 0.3);
    ctx.fillRect(Math.round(mx), top, 1, h);
  }
}
const tagAt = (px, py) => (py < MARKS_H ? markerTags.findLast((t) => px >= t.x - 2 && px <= t.x + t.w) : undefined);
function markerTip(m) {
  const where = m.barBeat.value ? ` at ${Luna.formatBarBeat(m.barBeat.value)}` : '', note = m.comments.value;
  return `${m.name.value ?? 'Marker'}${where}${note ? `: ${note}` : ''}. Click to move the playhead here.`;
}

// The Silence strip: swipe across it, like a take, to make that stretch of the comp silent.
// Silent stretches between comp sections show on it, as a take's chosen sections show on its row.
function paintSilence(ctx, list, W) {
  const top = SIL_TOP, h = SIL_H;
  ctx.fillStyle = '#1f1f1f';
  ctx.fillRect(GUTTER, top, W - GUTTER, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, top, W - GUTTER, h);
  ctx.clip();
  ctx.strokeStyle = '#292929';
  for (let px = GUTTER - h; px < W; px += 8) { ctx.beginPath(); ctx.moveTo(px, top + h); ctx.lineTo(px + h, top); ctx.stroke(); }
  const sorted = [...list].sort((a, b) => a.start - b.start);
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  for (let i = 1; i < sorted.length; i++) {
    const a = Math.max(GUTTER, x(sorted[i - 1].stop)), b = Math.min(W, x(sorted[i].start));
    if (b > a) ctx.fillRect(a, top + 3, b - a, h - 6);
  }
  ctx.restore();
  paintTidyMarks(ctx, W);
  const rect = preview?.rect;
  if (rect?.silence) {
    const a = Math.max(GUTTER, x(rect.a)), b = Math.min(W, x(rect.b));
    ctx.strokeStyle = '#ff7a7a';
    ctx.strokeRect(a + 0.5, top + 1.5, Math.max(1, b - a - 1), h - 3);
  }
  ctx.fillStyle = '#2f2f2f';
  ctx.fillRect(0, top, GUTTER, h);
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#9a9a9a';
  ctx.fillText(fitText(ctx, 'Silence: swipe to erase', GUTTER - 16), 10, top + h / 2);
  ctx.fillStyle = UI.headLine;
  ctx.fillRect(GUTTER - 1, top, 1, h);
  ctx.fillStyle = UI.sep;
  ctx.fillRect(0, top, W, 1);
}

// Tiny gaps and scraps Tidy lists (all but those left alone): an amber marker under the comp
// row, pointing up at each, with its length where there is room. A click on one opens Tidy.
const MARK_H = 11;
function tidyMarks() {
  if (!session || !track) return [];
  const alone = L.leftAlone(session, track), W = widthCss();
  return tidyBits.filter((b) => !alone.has(b.key)).map((b) => ({ bit: b, x: x((b.start + b.stop) / 2) })).filter((m) => m.x >= GUTTER && m.x <= W);
}
function paintTidyMarks(ctx, W) {
  const marks = tidyMarks(), top = SIL_TOP + 1;
  ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  marks.forEach((m, i) => {
    const cx = Math.round(m.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx - 6, top + MARK_H);
    ctx.lineTo(cx + 6, top + MARK_H);
    ctx.closePath();
    ctx.fillStyle = '#ffb347';
    ctx.fill();
    ctx.strokeStyle = '#3a2405';
    ctx.stroke();
    const text = msText(m.bit.ms), room = (marks[i + 1]?.x ?? W) - cx - 10;
    if (room > ctx.measureText(text).width + 4) { ctx.fillStyle = '#ffc56b'; ctx.fillText(text, cx + 9, top + MARK_H / 2 + 1); }
  });
}
const markAt = (px, py) => (py >= SIL_TOP && py < SIL_TOP + MARK_H + 4 ? tidyMarks().find((m) => Math.abs(m.x - px) <= 8) : undefined);

function paintTakes(grid) {
  const H = Math.max(1, takes.length * LANE_H), ctx = sizeCanvas($('takesCanvas'), H), W = widthCss();
  ctx.clearRect(0, 0, W, H);
  if (!session || !track) return;
  const list = shownSegments(), playing = session.playlistFor(track);
  takes.forEach((take, i) => {
    const top = i * LANE_H, pieces = scene?.lanes.get(take.id) ?? [], name = take.name.value ?? `Take ${take.version.value}`;
    ctx.fillStyle = UI.lane;
    ctx.fillRect(GUTTER, top, W - GUTTER, LANE_H);
    // The take's audio, greyed; the stretches the comp uses from it drawn as LUNA clips.
    for (const p of pieces) drawClip(ctx, p.start, p.stop, top + 1, LANE_H - 3, GHOST, '', [p]);
    const c = clipColors(take.id);
    for (const s of list) if (s.take === take.id) drawClip(ctx, s.start, s.stop, top + 1, LANE_H - 3, c, name, pieces);
    drawGrid(ctx, grid, top, LANE_H - 1);
    const rect = preview?.rect;
    if (rect?.take === take.id) {
      const a = Math.max(GUTTER, x(rect.a)), b = Math.min(W, x(rect.b));
      ctx.fillStyle = rect.erase ? 'rgba(255, 90, 90, 0.18)' : 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(a, top + 1, Math.max(1, b - a), LANE_H - 3);
      ctx.strokeStyle = rect.erase ? '#ff7a7a' : '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a + 0.75, top + 1.75, Math.max(1, b - a - 1.5), LANE_H - 4.5);
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = UI.sep;
    ctx.fillRect(GUTTER, top + LANE_H - 1, W - GUTTER, 1);
    label(ctx, name, top, LANE_H, playing === take, hue(take.id));
  });
  drawMarkerLines(ctx, 0, H);
}

function schedulePlayhead() {
  if (headFrame) return;
  headFrame = requestAnimationFrame(() => { headFrame = 0; placePlayhead(); });
}

function placePlayhead() {
  const tick = session?.transport.location.value?.tick;
  // While playing, page the view along so the playhead stays on screen.
  if (track && tick !== undefined && session.transport.playing.value && !drag && (tick < view.start || tick > view.end)) {
    const span = view.end - view.start, start = Math.max(0, tick - span * 0.1);
    view = { start, end: start + span };
    scheduleGather();
    schedulePaint();
  }
  const shown = !!track && tick !== undefined && tick >= view.start && tick <= view.end;
  for (const id of ['ph1', 'ph2']) {
    const el = $(id);
    el.hidden = !shown;
    if (shown) el.style.transform = `translateX(${x(tick)}px)`;
  }
}

// ── edits ──────────────────────────────────────────────────────────────────────────────

const current = () => pending ?? segments;
const sameList = (a, b) => JSON.stringify(L.merge(a)) === JSON.stringify(L.merge(b));

async function commit(next, force = false, replaceForeign = false) {
  if (busy) return;
  if (!force && sameList(next, current())) { schedulePaint(); return; }
  // Clips on the comp that the page did not put there (a recording, an edit made in LUNA) would
  // be replaced by this rebuild: hold the change and ask first.
  const foreign = replaceForeign ? [] : [
    ...(compLane ? L.foreignClips(session, compLane, track) : []),
    ...(groupActive() ? mates.flatMap((m) => (m.lane ? L.foreignClips(session, m.lane, m.track) : [])) : []),
  ];
  if (foreign.length) {
    held = { next, count: foreign.length };
    paintNotice();
    schedulePaint();
    return;
  }
  held = undefined;
  busy = true;
  pending = next;
  $('scroller').classList.add('busy');
  setStatus('Building the comp...', 'busy');
  schedulePaint();
  try {
    if (!compLane && !next.length) {
      await L.clearSaved(session, track);   // starting over: no playlist needed
    } else if (groupActive()) {
      // The same sections on every grouped track, each from its matching take: one undo step.
      if (!compLane) compLane = await L.ensureCompLane(session, track);
      const lanes = await L.buildGroupComp(session, track, compLane, mates, next, { fadeMs: fadeMs() });
      mates.forEach((m, i) => { m.lane = lanes[i + 1]; });
      for (const t of [track, ...mates.map((m) => m.track)]) await L.setFadeMs(session, t, fadeMs());
    } else {
      if (!compLane) compLane = await L.ensureCompLane(session, track);
      await L.buildComp(session, track, compLane, next, { fadeMs: fadeMs() });
      await L.setFadeMs(session, track, fadeMs());   // so the next visit keeps these seams' length
    }
    segments = L.savedSegments(session, track);
    setStatus(summary());
  } catch (e) {
    setStatus(`Could not build the comp: ${e.message ?? e}`, 'error');
  } finally {
    pending = undefined;
    busy = false;
    $('scroller').classList.remove('busy');
    if (rebindLater) await bindTrack(track?.id, false);
    scheduleGather();
    schedulePaint();
    scheduleNotice();
  }
}

/** A comp built before clips were named gets its clips named after their takes (one undo step). */
// Only for a comp from before the page named clips (it has no record of the clips it placed,
// which came later). Otherwise names that disagree come from an undo or a rename made in LUNA,
// and naming them here would make a new undo step under the user's feet and end their redo:
// the yellow line offers it instead, and the next swipe names every clip anyway.
async function nameClipsIfNeeded() {
  if (!track || !compLane || busy || Array.isArray(L.store(session).value(track.id, 'placed').value)) return;
  if (!L.misnamedCompClips(session, compLane, segments).length) return;
  busy = true;
  try {
    await L.nameCompClips(session, compLane, segments);
  } catch (e) {
    setStatus(`Could not name the comp clips: ${e.message ?? e}`, 'error');
  } finally {
    busy = false;
  }
}

let analyzing = false;
/** Have LUNA analyse any take it has no waveform for yet. Only while stopped, so nothing is heard. */
async function drawMissingWaveforms() {
  if (!track || busy || analyzing || session.transport.playing.value) return;
  analyzing = true;
  let mine = false;   // whether this call set `busy`, so it only clears its own
  try {
    const missing = await L.unanalyzed(session, compLane ? [compLane, ...takes] : takes);
    if (!missing.length || busy || session.transport.playing.value) return;
    busy = mine = true;
    setStatus(`Asking LUNA for the waveforms of ${missing.length} take${missing.length === 1 ? '' : 's'}...`, 'busy');
    const done = await L.analyzeTakes(session, track, missing);
    for (const s of done) cache.invalidate(s.id);
    setStatus(summary());
  } catch (e) {
    setStatus(`Could not get every waveform: ${e.message ?? e}`, 'error');
  } finally {
    analyzing = false;
    if (mine) {
      busy = false;
      if (rebindLater) await bindTrack(track?.id, false);
    }
    scheduleGather();
    schedulePaint();
  }
}

async function audition(lane) {
  if (!lane || busy) return;
  try { await playEverywhere(lane); } catch (e) { setStatus(e.message, 'error'); }
  schedulePaint();
}

// ── pointer and wheel ──────────────────────────────────────────────────────────────────

const takesCanvas = $('takesCanvas'), topCanvas = $('topCanvas');
const localX = (e, el) => e.clientX - el.getBoundingClientRect().left;
const localY = (e, el) => e.clientY - el.getBoundingClientRect().top;

// Section edges can be grabbed: on a take's row, the edges of that take's lit sections; on the
// comp row, any section's edges, a seam between two sections being one edge. LUNA's web view
// draws no w-resize / e-resize pointer (fact 118), so the edge pointer is an SVG image.
const EDGE_PX = 5;
const EDGE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="16"><path d="M1 8 L6 3 V6 H16 V3 L21 8 L16 13 V10 H6 V13 Z" fill="white" stroke="black" stroke-width="1"/></svg>',
)}") 11 8, ew-resize`;
const minLen = () => Math.max(Luna.TICKS_PER_BEAT / 16, ((view.end - view.start) / Math.max(1, widthCss() - GUTTER)) * 4);

/** The grabbable edge nearest `px`: { sec, side }, or undefined. Only `takeId`'s sections when given. */
function edgeAt(px, takeId) {
  const list = current();
  let best;
  for (const s of list) {
    if (takeId && s.take !== takeId) continue;
    for (const side of ['start', 'stop']) {
      const d = Math.abs(x(s[side]) - px);
      if (d <= EDGE_PX && (!best || d < best.d)) best = { sec: s, side, d };
    }
  }
  if (best && !takeId && best.side === 'start') {
    const prev = list.find((p) => p.stop === best.sec.start);   // a seam: drag it as the left section's end
    if (prev) return { sec: prev, side: 'stop' };
  }
  return best;
}

function beginEdgeDrag(e, el, edge) {
  const take = session.playlists.byId(edge.sec.take);
  drag = { kind: 'edge', edge, extent: take ? L.extent([take]) : undefined, x0: localX(e, el) };
  el.setPointerCapture(e.pointerId);
}

function moveEdgeDrag(px) {
  if (!preview && Math.abs(px - drag.x0) < 2) return;
  const list = L.moveEdge(current(), drag.edge.sec, drag.edge.side, snapTick(tickAt(px)), { extent: drag.extent, minLen: minLen() });
  preview = { list };
  schedulePaint();
}

function endDrag() {
  const next = preview?.list;
  drag = undefined;
  preview = undefined;
  if (next) void commit(next);
  else schedulePaint();
}

takesCanvas.addEventListener('pointerdown', (e) => {
  if (!track || busy || e.button !== 0) return;
  const px = localX(e, takesCanvas), take = takes[Math.floor(localY(e, takesCanvas) / LANE_H)];
  if (!take || px < GUTTER) return;   // clicks on a name are handled by click / dblclick below
  const edge = !e.altKey && edgeAt(px, take.id);
  if (edge) { beginEdgeDrag(e, takesCanvas, edge); return; }
  drag = { kind: 'swipe', take, x0: px, t0: tickAt(px), erase: e.altKey };
  takesCanvas.setPointerCapture(e.pointerId);
});

takesCanvas.addEventListener('pointermove', (e) => {
  const px = localX(e, takesCanvas);
  if (!drag) {
    const take = takes[Math.floor(localY(e, takesCanvas) / LANE_H)];
    takesCanvas.style.cursor = track && take && px >= GUTTER && !busy && edgeAt(px, take.id) ? EDGE_CURSOR : '';
    return;
  }
  if (drag.kind === 'edge') { moveEdgeDrag(px); return; }
  if (!preview && Math.abs(px - drag.x0) < 4) return;
  const range = L.clampToExtent(snapTick(drag.t0), snapTick(tickAt(px)), L.extent([drag.take]));
  preview = range
    ? {
        list: drag.erase ? L.clearRange(current(), range[0], range[1]) : L.applySwipe(current(), drag.take.id, range[0], range[1]),
        rect: { take: drag.take.id, a: range[0], b: range[1], erase: drag.erase },
      }
    : undefined;
  schedulePaint();
});

takesCanvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.kind === 'edge') { endDrag(); return; }
  const d = drag, px = localX(e, takesCanvas);
  if (!preview && Math.abs(px - d.x0) < 4) {
    const tick = tickAt(px), list = current();
    let next;
    if (d.erase) {
      const hit = list.find((s) => s.start <= tick && tick < s.stop);
      next = hit ? L.clearRange(list, hit.start, hit.stop) : undefined;
    } else {
      next = L.clickChoose(list, d.take.id, tick, L.extent([d.take]));
    }
    drag = undefined;
    if (next) void commit(next);
    else schedulePaint();
    return;
  }
  endDrag();
});

takesCanvas.addEventListener('pointercancel', () => { drag = undefined; preview = undefined; schedulePaint(); });

// A take's name: one click plays that take alone (after a short wait, in case it is the
// first click of a double-click); a double-click renames it.
let nameClickTimer;
const takeUnder = (e) => takes[Math.floor(localY(e, takesCanvas) / LANE_H)];
takesCanvas.addEventListener('click', (e) => {
  if (!track || localX(e, takesCanvas) >= GUTTER) return;
  const take = takeUnder(e);
  if (!take) return;
  clearTimeout(nameClickTimer);
  nameClickTimer = setTimeout(() => void audition(take), 250);
});
takesCanvas.addEventListener('dblclick', (e) => {
  if (!track || localX(e, takesCanvas) >= GUTTER) return;
  clearTimeout(nameClickTimer);
  const row = Math.floor(localY(e, takesCanvas) / LANE_H);
  if (takes[row]) startRename(takes[row], row);
});

function startRename(take, row) {
  const input = $('rename');
  input.value = take.name.value ?? '';
  input.style.top = `${row * LANE_H + 2}px`;
  input.style.width = `${GUTTER - 14}px`;
  input.hidden = false;
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    input.hidden = true;
    input.onkeydown = input.onblur = null;
    if (save && !busy) {
      busy = true;
      try {
        if (groupActive()) {
          // Comping a group, the matching take on each grouped track gets the name too: one undo step.
          await session.transaction('Rename take', async () => {
            await L.renameTake(session, take, input.value, compLane, current());
            for (const m of mates) {
              const other = session.playlists.byId(m.map.get(take.id));
              if (other) await L.renameTake(session, other, input.value, m.lane, L.savedSegments(session, m.track));
            }
          });
        } else {
          await L.renameTake(session, take, input.value, compLane, current());
        }
      } catch (e) {
        setStatus(`Could not rename the take: ${e.message ?? e}`, 'error');
      } finally {
        busy = false;
      }
    }
    schedulePaint();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();   // typing a name is not LUNA shortcuts
    if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
  };
  input.onblur = () => void finish(true);
}

topCanvas.addEventListener('pointerdown', (e) => {
  if (!track || e.button !== 0) return;
  const px = localX(e, topCanvas), py = localY(e, topCanvas);
  const inComp = py >= RULER_H && py < SIL_TOP, inSilence = py >= SIL_TOP;
  if (px < GUTTER) { if (inComp && compLane) void audition(compLane); return; }
  if (inSilence && markAt(px, py)) { tidyOpen = true; tidyShown = ''; schedulePaint(); return; }
  const tag = tagAt(px, py);
  if (tag) { void session.transport.seek(Math.max(0, Math.round(tag.m.location.value))); return; }
  if (inSilence) {
    if (busy) return;
    drag = { kind: 'silence', x0: px, t0: tickAt(px) };
    topCanvas.setPointerCapture(e.pointerId);
    return;
  }
  const edge = inComp && !busy && edgeAt(px);
  if (edge) { beginEdgeDrag(e, topCanvas, edge); return; }
  void session.transport.seek(Math.max(0, Math.round(tickAt(px))));
});
topCanvas.addEventListener('pointermove', (e) => {
  const px = localX(e, topCanvas), py = localY(e, topCanvas);
  if (!drag) {
    const tag = track && px >= GUTTER ? tagAt(px, py) : undefined, tip = tag ? markerTip(tag.m) : '';
    if (topCanvas.title !== tip) topCanvas.title = tip;
    topCanvas.style.cursor = !track || px < GUTTER ? '' : tag || markAt(px, py) ? 'pointer' : py >= RULER_H && py < SIL_TOP && !busy && edgeAt(px) ? EDGE_CURSOR : '';
    return;
  }
  if (drag.kind === 'edge') { moveEdgeDrag(px); return; }
  if (drag.kind === 'silence') {
    if (!preview && Math.abs(px - drag.x0) < 4) return;
    const t0 = snapTick(drag.t0), t1 = snapTick(tickAt(px));
    const a = Math.max(0, Math.min(t0, t1)), b = Math.max(t0, t1);
    preview = b > a ? { list: L.clearRange(current(), a, b), rect: { silence: true, a, b } } : undefined;
    schedulePaint();
  }
});
topCanvas.addEventListener('pointerup', (e) => {
  if (drag?.kind === 'edge') { endDrag(); return; }
  if (drag?.kind !== 'silence') return;
  if (!preview) {
    // A click on the strip silences the whole comp section above it.
    const tick = tickAt(localX(e, topCanvas)), list = current();
    const hit = list.find((s) => s.start <= tick && tick < s.stop);
    drag = undefined;
    if (hit) void commit(L.clearRange(list, hit.start, hit.stop));
    else schedulePaint();
    return;
  }
  endDrag();
});
topCanvas.addEventListener('pointercancel', () => { drag = undefined; preview = undefined; schedulePaint(); });

function onWheel(e) {
  if (!track) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.01), tickAt(localX(e, $('top'))));
  } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
    e.preventDefault();
    const d = e.deltaX || e.deltaY;
    pan((d / Math.max(1, widthCss() - GUTTER)) * (view.end - view.start));
  }
}
$('top').addEventListener('wheel', onWheel, { passive: false });
$('scroller').addEventListener('wheel', onWheel, { passive: false });

// Leave this page for LUNA's own Timeline or Mixer. LUNA keeps the Add On a click away, on its
// toolbar and in the Timeline / Mixer / Add On view toggle.
async function goTo(page) {
  try {
    if (luna && (await luna.gui.available())) await luna.gui.setPage(page);
  } catch (e) {
    setStatus(`Could not switch to the ${page}: ${e.message ?? e}`, 'error');
  }
}
$('toTimeline').onclick = () => void goTo('timeline');
$('toMixer').onclick = () => void goTo('mixer');

// A warning line when what LUNA will play is not the comp: another playlist is playing on this
// track, or a solo elsewhere silences it. Each comes with a one-click fix.
let noticeFix, noticeAlt, noticeTimer;
// Names arrive one by one after an undo or a rename; look once they have settled.
function scheduleNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(paintNotice, 200);
}
function paintNotice() {
  let text = '', fixLabel = '', altLabel = '';
  noticeFix = noticeAlt = undefined;
  if (session && track) {
    const playing = session.playlistFor(track);
    const othersSoloed = session.visibleTracks.filter((t) => t !== track && t.solo?.on === true);
    if (held) {
      const one = held.count === 1;
      text = `${compLane?.name.value ?? L.COMP_NAME} has ${held.count} clip${one ? '' : 's'} Swipe Comp didn't put there (a recording, or an edit made in LUNA). Your change would replace ${one ? 'it' : 'them'}.`;
      fixLabel = `Replace ${one ? 'it' : 'them'}`;
      const { next } = held;
      noticeFix = () => commit(next, true, true);
      altLabel = 'Cancel my change';
      noticeAlt = () => { held = undefined; paintNotice(); schedulePaint(); };
    } else if (!compLane && segments.length) {
      text = `The ${L.COMP_NAME} playlist is gone (deleted in LUNA?). Your ${segments.length} comp section${segments.length === 1 ? ' is' : 's are'} still saved.`;
      fixLabel = 'Rebuild it';
      noticeFix = () => commit(current(), true);
    } else if (compLane && playing && playing !== compLane) {
      text = `LUNA is playing ${playing.name.value} on this track, not the comp.`;
      fixLabel = 'Hear the comp';
      noticeFix = () => audition(compLane);
    } else if (compLane && groupActive() && mates.some((m) => m.lane && session.playlistFor(m.track) !== m.lane)) {
      const off = mates.filter((m) => m.lane && session.playlistFor(m.track) !== m.lane);
      text = `${off.map((m) => `"${m.track.name.value}"`).join(', ')} ${off.length === 1 ? 'is' : 'are'} not playing ${off.length === 1 ? 'its' : 'their'} comp.`;
      fixLabel = 'Hear the comp';
      noticeFix = () => audition(compLane);
    } else if (othersSoloed.length && track.solo?.on !== true) {
      text = `Solo is on for ${othersSoloed.map((t) => `"${t.name.value}"`).join(', ')}, so this track is silent.`;
      fixLabel = 'Solo this track too';
      noticeFix = () => track.solo.toggle();
    } else if (compLane && L.compBelowNewer(session, track, compLane) && L.keepsOnTop(session, track)) {
      text = `${compLane.name.value} is below newer takes in LUNA's playlist list. Your next change moves it back to the top.`;
      fixLabel = 'Move it to the top now';
      noticeFix = async () => {
        for (const m of [{ track, lane: compLane }, ...(groupActive() ? mates.filter((x) => x.lane) : [])]) await L.keepCompOnTop(session, m.track, m.lane);
      };
      altLabel = 'Leave it here';
      noticeAlt = async () => {
        for (const t of [track, ...(groupActive() ? mates.map((m) => m.track) : [])]) await L.setKeepOnTop(session, t, false);
        paintNotice();
      };
    } else if (compLane && !busy && L.misnamedCompClips(session, compLane, segments).length) {
      const n = L.misnamedCompClips(session, compLane, segments).length;
      text = `${n} comp clip${n === 1 ? '' : 's'} in LUNA's Timeline ${n === 1 ? 'has' : 'have'} a name that isn't ${n === 1 ? 'its' : 'their'} take's (after an undo, or a take renamed in LUNA). Your next change names them too.`;
      fixLabel = 'Name them now';
      noticeFix = async () => { busy = true; try { await L.nameCompClips(session, compLane, segments); } finally { busy = false; paintNotice(); } };
    }
  }
  paintRaise();
  $('notice').style.display = text ? 'flex' : 'none';
  if ($('noticeText').textContent !== text) $('noticeText').textContent = text;
  $('noticeFix').textContent = fixLabel;
  $('noticeAlt').textContent = altLabel;
  $('noticeAlt').style.display = altLabel ? '' : 'none';
}
// After "Leave it here": a quiet button in the comp row's name area, for when SwipeComp should
// go back to the top of LUNA's list (and stay there as you comp).
function paintRaise() {
  const show = !!(session && track && compLane && L.compBelowNewer(session, track, compLane) && !L.keepsOnTop(session, track));
  $('raise').hidden = !show;
}
$('raise').addEventListener('mousedown', (e) => e.preventDefault());
$('raise').onclick = () => {
  if (!session || !track || !compLane || busy) return;
  const all = [{ track, lane: compLane }, ...(groupActive() ? mates.filter((m) => m.lane) : [])];
  (async () => { for (const m of all) await L.keepCompOnTop(session, m.track, m.lane); })()
    .then(paintNotice, (e) => setStatus(e.message ?? String(e), 'error'));
};

for (const [id, get] of [['noticeFix', () => noticeFix], ['noticeAlt', () => noticeAlt]]) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
  $(id).onclick = () => { const fn = get(); if (fn) Promise.resolve(fn()).catch((e) => setStatus(e.message ?? String(e), 'error')); };
}

// Play / stop and solo, mirroring LUNA's state.
function paintTransport() {
  paintNotice();
  const playing = session?.transport.playing.value === true, soloed = track?.solo?.on === true;
  const play = $('play'), solo = $('solo');
  const text = playing ? '■ Stop' : '▶ Play';
  if (play.textContent !== text) play.textContent = text;
  play.classList.toggle('on', playing);
  solo.classList.toggle('on', soloed);
  solo.disabled = !track;
}
$('play').onclick = () => {
  if (!session) return;
  L.playOrStop(session, view.start, view.end).catch((e) => setStatus(e.message ?? String(e), 'error'));
};
$('solo').onclick = () => { if (track) track.solo.toggle().catch((e) => setStatus(e.message ?? String(e), 'error')); };

// Undo and Redo step through LUNA's own undo history (shared with everything done in LUNA). LUNA's
// Cmd+Z is not sure to reach a full Add On page, so the page has buttons, named after the step
// they would take, and handles Cmd+Z and Shift+Cmd+Z itself.
let undoSteps = { undo: '', redo: '' }, undoTimer;
function scheduleUndoSteps() {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => void readUndoSteps(), 120);
}
async function readUndoSteps() {
  if (!session) { undoSteps = { undo: '', redo: '' }; paintUndo(); return; }
  try {
    const at = `/sessions/${session.uid}`;
    const [cur, queue] = await Promise.all([luna.raw.get(`${at}/undo_uid`), luna.raw.get(`${at}/undo_queues`, { levels: 2 })]);
    const entries = (queue?.children ?? []).filter((c) => c.properties).map((c) => ({
      rowid: c.properties.rowid?.value, uid: c.properties.uid?.value, name: c.properties.name?.value,
    }));
    undoSteps = L.undoSteps(entries, cur?.value, { canUndo: session.canUndo.value, canRedo: session.canRedo.value });
  } catch {
    undoSteps = { undo: '', redo: '' };   // the buttons still work, unnamed
  }
  paintUndo();
}
function paintUndo() {
  const u = $('undo'), r = $('redo');
  const canU = !!session && !busy && session.canUndo.value === true, canR = !!session && !busy && session.canRedo.value === true;
  if (u.disabled !== !canU) u.disabled = !canU;
  if (r.disabled !== !canR) r.disabled = !canR;
  const ut = keyNames(undoSteps.undo ? `Undo "${undoSteps.undo}" (Cmd+Z)` : 'Undo (Cmd+Z)');
  const rt = keyNames(undoSteps.redo ? `Redo "${undoSteps.redo}" (Shift+Cmd+Z)` : 'Redo (Shift+Cmd+Z)');
  if (u.title !== ut) u.title = ut;
  if (r.title !== rt) r.title = rt;
}
async function undoOrRedo(redo) {
  if (!session || busy) return;
  if (!(redo ? session.canRedo.value : session.canUndo.value)) return;
  const name = redo ? undoSteps.redo : undoSteps.undo;
  try {
    await (redo ? session.redo() : session.undo());
    setStatus(`${redo ? 'Redid' : 'Undid'} ${name ? `"${name}"` : 'the last change'}`);
  } catch (e) {
    setStatus(e.message ?? String(e), 'error');
  }
}
$('undo').onclick = () => void undoOrRedo(false);
$('redo').onclick = () => void undoOrRedo(true);
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
  const el = e.target;
  if ((el instanceof HTMLInputElement && el.type !== 'checkbox') || el instanceof HTMLTextAreaElement) return;   // a text box keeps its own undo
  e.preventDefault();   // claimed, so LUNA does not undo a second time
  void undoOrRedo(e.shiftKey);
}, true);

// Header controls never keep the keyboard focus, so Space always reaches LUNA as play / stop
// rather than pressing the last button clicked (Clear comp, say) again.
for (const b of document.querySelectorAll('header button')) b.addEventListener('mousedown', (e) => e.preventDefault());
for (const el of document.querySelectorAll('header select, header input')) {
  el.addEventListener('change', () => el.blur());
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') el.blur(); });
}

$('fit').onclick = fit;
$('zoomIn').onclick = () => zoom(0.5);
$('zoomOut').onclick = () => zoom(2);
$('clear').onclick = () => { if (track && !busy && current().length) void commit([]); };
$('track').onchange = () => void bindTrack($('track').value, true);

// Base: fill the comp's gaps with one take (on an empty comp, the whole take).
function fillBaseSelect() {
  const sel = $('base');
  sel.replaceChildren(new Option('a take…', ''), ...takes.map((t) => new Option(t.name.value ?? t.id, t.id)));
  sel.value = '';
}
$('base').onchange = () => {
  const take = takes.find((t) => t.id === $('base').value);
  $('base').value = '';
  if (!take || !track || busy) return;
  const next = L.fillGaps(current(), take.id, L.extent([take]));
  if (sameList(next, current())) { setStatus(`No gaps for ${take.name.value} to fill: the comp has a section wherever it has audio.`); return; }
  void commit(next);
};
// What Base does depends on the comp: on an empty one it starts the comp from a whole take.
function paintBase() {
  const text = current().length ? 'Fill gaps from' : 'Start from';
  if ($('baseText').textContent !== text) $('baseText').textContent = text;
}

// ── Tidy: tiny gaps and scraps ──────────────────────────────────────────────────────────
// A swipe that stops just short of a section leaves a sliver of silence; one that stops just
// past it leaves a scrap of a take a few ms long. Tidy lists them (under L.TINY_MS). For each,
// the user picks which neighbouring take fills it (or silence, for a scrap), or to leave it
// alone; nothing is picked for them. Apply makes the picks as one undo step; "Leave it" is
// remembered, and those stop being counted.
let tidyBits = [], tidyOpen = false, tidyShown = '';
const tinyMs = (a, b) => { const t = session.musical.timeline; return (t.seconds(b) - t.seconds(a)) * 1000; };
const extentOf = (id) => { const p = session.playlists.byId(id); return p ? L.extent([p]) : undefined; };
const msText = (v) => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
const tidyRows = () => [...$('tidyList').querySelectorAll('.tidyRow')];
function paintTidy() {
  tidyBits = session && track && session.musical.timeline.tempoLoaded ? L.tinyBits(current(), tinyMs) : [];
  const alone = track ? L.leftAlone(session, track) : new Set();
  const open = tidyBits.filter((b) => !alone.has(b.key)).length, btn = $('tidy');
  btn.hidden = tidyBits.length === 0;
  const label = open ? `Tidy (${open})` : 'Tidy';
  if (btn.textContent !== label) btn.textContent = label;
  btn.classList.toggle('quiet', !open);
  if (!tidyBits.length) tidyOpen = false;
  $('tidyPanel').hidden = !tidyOpen;
  if (tidyOpen) fillTidyList(alone);
  $('tidyGo').disabled = busy || !tidyRows().some((r) => r.dataset.use && r.dataset.use !== 'leave');
}
function fillTidyList(alone) {
  const sig = tidyBits.map((b) => b.key).join('|');
  if (sig === tidyShown) return;
  const picked = new Map(tidyRows().map((r) => [r.dataset.key, r.dataset.use]));
  tidyShown = sig;
  const t = session.musical.timeline;
  $('tidyList').replaceChildren(...tidyBits.map((b) => {
    const bb = t.barBeat(b.start), where = `bar ${bb.bar}, beat ${bb.beat}`;
    const what = b.kind === 'gap'
      ? `${msText(b.ms)} of silence between ${nameOf(b.before)} and ${nameOf(b.after)}, ${where}`
      : `${msText(b.ms)} of ${nameOf(b.take)}${b.before || b.after ? ` between ${b.before ? nameOf(b.before) : 'silence'} and ${b.after ? nameOf(b.after) : 'silence'}` : ' on its own'}, ${where}`;
    const row = document.createElement('div');
    row.className = 'tidyRow';
    row.dataset.key = b.key;
    row.dataset.use = picked.get(b.key) ?? (alone.has(b.key) ? 'leave' : '');
    const text = document.createElement('span');
    text.textContent = what;
    const choices = document.createElement('span');
    choices.className = 'choices';
    const choice = (value, caption, title, ok = true) => {
      const c = document.createElement('button');
      c.textContent = caption;
      c.title = title;
      c.dataset.value = value;
      c.disabled = !ok;
      c.classList.toggle('picked', row.dataset.use === value);
      c.onclick = () => {
        row.dataset.use = row.dataset.use === value ? '' : value;   // a second click unpicks
        for (const o of choices.children) o.classList.toggle('picked', o.dataset.value === row.dataset.use);
        schedulePaint();
      };
      return c;
    };
    choices.append(document.createTextNode(b.kind === 'gap' ? 'Fill with' : 'Replace with'));
    for (const o of L.tidyTakes(b, extentOf)) {
      choices.append(choice(o.take, nameOf(o.take), o.ok ? `${nameOf(o.take)} fills it` : `${nameOf(o.take)} has no audio there`, o.ok));
    }
    if (b.kind === 'scrap') choices.append(choice('silence', 'Silence', 'Make it silent'));
    choices.append(choice('leave', 'Leave it', 'Leave it as it is, and stop counting it'));
    const show = document.createElement('button');
    show.textContent = 'Show';
    show.title = 'Zoom in on it';
    show.onclick = () => showTick(b.start, b.stop);
    row.append(text, choices, show);
    return row;
  }));
}
function showTick(a, b) {
  const span = Math.max(Luna.QUARTER_NOTE, (b - a) * 60), mid = (a + b) / 2;
  view = { start: Math.max(0, mid - span / 2), end: Math.max(0, mid - span / 2) + span };
  scheduleGather();
  schedulePaint();
}
async function closeTidy(apply) {
  const rows = tidyRows();
  const leave = rows.filter((r) => r.dataset.use === 'leave').map((r) => r.dataset.key);
  const choices = rows
    .filter((r) => r.dataset.use && r.dataset.use !== 'leave')
    .map((r) => ({ bit: tidyBits.find((b) => b.key === r.dataset.key), use: r.dataset.use === 'silence' ? null : r.dataset.use }))
    .filter((c) => c.bit);
  tidyOpen = false;
  tidyShown = '';
  if (track) await L.setLeftAlone(session, track, leave);
  if (apply && choices.length) await commit(L.tidy(current(), choices));
  schedulePaint();
}
$('tidy').onclick = () => { tidyOpen = !tidyOpen; tidyShown = ''; schedulePaint(); };
$('tidyGo').onclick = () => void closeTidy(true);
$('tidyClose').onclick = () => void closeTidy(false);
// Like the header's controls, the panel never keeps the keyboard focus (Space stays play / stop).
$('tidyPanel').addEventListener('mousedown', (e) => e.preventDefault());

window.addEventListener('resize', () => { scheduleGather(); schedulePaint(); });

// ── binding to LUNA ────────────────────────────────────────────────────────────────────

function fillTrackSelect() {
  const sel = $('track'), list = session ? L.compableTracks(session) : [];
  // Every audio track, in the session's order, with its number of takes. A track with one take
  // is comped by keeping the parts of it you want (and silencing the rest).
  sel.replaceChildren(...list.map((t) => {
    const n = L.takesOf(session, t).length;
    return new Option(`${t.name.value ?? t.id} (${n} take${n === 1 ? '' : 's'})`, t.id);
  }));
  if (track && list.includes(track)) sel.value = track.id;
  const empty = $('empty');
  empty.style.display = list.length ? 'none' : 'block';
  empty.textContent = session ? 'This session has no audio tracks yet.' : '';
  return list;
}

let rebindTimer;
function scheduleRebind() {
  clearTimeout(rebindTimer);
  rebindTimer = setTimeout(() => { if (busy) rebindLater = true; else void bindTrack(track?.id, false); }, 60);
}

function bindClipProps() {
  release(clipOffs);
  for (const lane of compLane ? [compLane, ...takes] : takes) {
    for (const clip of lane.clips.items) {
      for (const prop of [clip.start, clip.stop, clip.sourceStart, clip.layer, clip.gain, clip.renderSourceUid]) clipOffs.push(prop.onChange(scheduleGather));
      if (lane === compLane) clipOffs.push(clip.name.onChange(scheduleNotice));
    }
  }
}

async function bindTrack(id, refit) {
  release(trackOffs);
  release(clipOffs);
  rebindLater = false;
  if (!track || track.id !== id) {
    held = undefined;                                  // a held change belongs to its track
    mates = []; release(groupOffs); paintGroup();      // and so does a group, until refreshGroup looks again
  }
  track = id ? session.tracks.byId(id) : undefined;
  if (!track) { takes = []; compLane = undefined; segments = []; scene = undefined; mates = []; release(groupOffs); paintGroup(); setStatus(summary()); schedulePaint(); return; }
  $('track').value = track.id;
  const lanes = L.playlistsOf(session, track);
  await Promise.all([...lanes.map((p) => p.clips.load()), track.controls.load()]);
  trackOffs.push(track.solo.real.onChange(paintTransport));
  paintTransport();
  compLane = L.compLaneOf(session, track);
  const oldestFirst = L.takesOf(session, track);
  // Colours follow recording order among takes with something on them: the order group comping
  // pairs takes in, so take 1 is one colour on every grouped track, take 2 another, and an empty
  // New Version on one track does not shift them.
  const recorded = L.recordedTakes(session, track);
  colorIndex = new Map([...recorded, ...oldestFirst.filter((p) => !recorded.includes(p))].map((p, i) => [p.id, i]));
  takes = [...oldestFirst].reverse();   // newest take at the top, as in LUNA's Timeline
  fillBaseSelect();
  // The crossfade length this track's comp was built with (10 ms for a comp built before the
  // page saved it, which is what those were built with unless the box was changed).
  if (track.id !== fadeShownFor) { $('fade').value = String(L.savedFadeMs(session, track) ?? 10); fadeShownFor = track.id; }
  segments = L.prune(L.savedSegments(session, track), takes.map((p) => p.id));
  const saved = L.store(session).value(track.id, 'segments');
  trackOffs.push(saved.onChange(() => {
    segments = L.prune(L.savedSegments(session, track), takes.map((p) => p.id));
    if (!busy) setStatus(summary());
    schedulePaint();
    scheduleNotice();
  }));
  trackOffs.push(L.store(session).value(track.id, 'placed').onChange(scheduleNotice));
  trackOffs.push(track.playlistUid.onChange(() => { paintNotice(); schedulePaint(); }));
  trackOffs.push(L.store(session).value(track.id, 'onTop').onChange(paintNotice));
  trackOffs.push(track.name.onChange(() => { fillTrackSelect(); setStatus(summary()); }));
  for (const lane of lanes) {
    // scheduleGroup: a take that just got its recording changes the take counts the group comp checks.
    trackOffs.push(lane.clips.onChange(() => { bindClipProps(); scheduleGather(); scheduleNotice(); scheduleGroup(); }));
    trackOffs.push(lane.name.onChange(() => { fillBaseSelect(); schedulePaint(); scheduleNotice(); }));
    trackOffs.push(lane.version.onChange(scheduleRebind));   // take numbers moved: re-sort the takes
  }
  bindClipProps();
  setStatus(summary());
  void refreshGroup();
  if (refit) fit();
  scheduleGather();
  schedulePaint();
  void (async () => { await nameClipsIfNeeded(); await drawMissingWaveforms(); })();
}

async function bindSession() {
  release(sessionOffs);
  release(trackOffs);
  release(clipOffs);
  track = undefined; compLane = undefined; takes = []; segments = []; scene = undefined; fadeShownFor = undefined;
  session = luna.sessions.current();
  if (!session) { fillTrackSelect(); setStatus('No session open'); schedulePaint(); return; }
  setStatus(`Loading ${session.name.value ?? ''}...`);
  await session.ready();
  await Promise.all([session.musical.ready(), session.playlists.load(), session.sources?.load(), L.store(session).load(), session.markers.load()]);
  // LUNA's markers on the ruler: follow them being added, removed, moved, renamed or recoloured.
  let markerOffs = [];
  const watchMarkers = () => {
    release(markerOffs);
    for (const m of session.markers.items) for (const p of [m.name, m.location, m.color]) markerOffs.push(p.onChange(schedulePaint));
    schedulePaint();
  };
  sessionOffs.push(() => release(markerOffs));
  sessionOffs.push(session.markers.onChange(watchMarkers));
  watchMarkers();
  sessionOffs.push(session.playlists.onChange(() => {
    fillTrackSelect();
    if (busy) rebindLater = true;
    else void bindTrack(track?.id, false);
  }));
  // Every track's solo, so the page can say when a solo elsewhere silences this track.
  let soloOffs = [];
  const watchSolos = async () => {
    release(soloOffs);
    await Promise.all(session.visibleTracks.map((t) => t.controls.load().catch(() => {})));
    for (const t of session.visibleTracks) if (t.solo) soloOffs.push(t.solo.real.onChange(paintTransport));
    paintTransport();
  };
  sessionOffs.push(() => release(soloOffs));
  sessionOffs.push(session.tracks.onChange(() => { fillTrackSelect(); void watchSolos(); }));
  void watchSolos();
  sessionOffs.push(session.transport.location.onChange(schedulePlayhead));
  for (const p of [session.canUndo, session.canRedo, session.changeCount]) sessionOffs.push(p.onChange(scheduleUndoSteps));
  // Groups switched on or off (the edit context's group selection), or their members changed.
  sessionOffs.push(luna.raw.subscribe(`${session.path}/contexts/main`, scheduleGroup));
  sessionOffs.push(luna.raw.subscribe(`${session.path}/groups`, scheduleGroup, { recursive: true }));
  sessionOffs.push(() => release(groupOffs));
  scheduleUndoSteps();
  sessionOffs.push(session.transport.playing.onChange(() => {
    paintTransport();
    if (!session.transport.playing.value) void drawMissingWaveforms();
  }));
  paintTransport();
  sessionOffs.push(session.musical.timeline.onChange(scheduleGather));
  sessionOffs.push(session.context.waveformZoom.onChange(scheduleGather));
  for (const p of [session.context.grid, session.context.gridEnable, session.context.property('grid_modifier'), session.context.property('grid_adaptive')]) {
    sessionOffs.push(p.onChange(schedulePaint));   // LUNA's Grid: the lines drawn and what Snap uses
  }
  if (session.sources) sessionOffs.push(session.sources.onChange(scheduleGather));
  // Open LUNA's selected track; failing that, the first with takes to swipe between.
  const list = fillTrackSelect(), focused = session.focusedTrack.value;
  const severalTakes = list.find((t) => L.takesOf(session, t).length > 1);
  await bindTrack((list.find((t) => t === focused) ?? severalTakes ?? list[0])?.id, true);
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      setStatus(e instanceof Luna.NotRunning ? 'Waiting for LUNA...' : e.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's undo, redo, play and record keys keep working while this page has the focus.
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  const rebind = () => bindSession().catch((e) => setStatus(`Could not read the session: ${e.message ?? e}`, 'error'));
  luna.sessions.focused.onChange(rebind);
  luna.sessions.items.onChange(rebind);
  luna.status.onChange(() => { if (luna.status.value === 'disconnected') setStatus('Reconnecting...'); });
  await rebind();
}

connect();
