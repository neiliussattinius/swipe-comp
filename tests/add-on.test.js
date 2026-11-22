// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

// The SDK bundle the page itself loads (vendor/luna.global.js, Luna.MockEngine included), so the
// tests run the code that ships and need nothing from UA beyond this folder.
const Luna = new Function(`${readFileSync(new URL('../vendor/luna.global.js', import.meta.url), 'utf8')}\nreturn Luna;`)();

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const L = globalThis.AddOnLogic;
const BAR = Luna.WHOLE_NOTE;
const BEAT = Luna.QUARTER_NOTE;

describe('the comp list', () => {
  it('a swipe takes over what it covers and splits what it lands inside', () => {
    let s = L.applySwipe([], 'A', 0, 8 * BAR);
    s = L.applySwipe(s, 'B', 2 * BAR, 4 * BAR);
    expect(s).toEqual([
      { start: 0, stop: 2 * BAR, take: 'A' },
      { start: 2 * BAR, stop: 4 * BAR, take: 'B' },
      { start: 4 * BAR, stop: 8 * BAR, take: 'A' },
    ]);
  });

  it('swiping right to left is the same as left to right, and neighbours from one take join', () => {
    let s = L.applySwipe([], 'A', 4 * BAR, 0);
    s = L.applySwipe(s, 'A', 4 * BAR, 6 * BAR);
    expect(s).toEqual([{ start: 0, stop: 6 * BAR, take: 'A' }]);
  });

  it('clearing a range leaves a gap', () => {
    const s = L.clearRange([{ start: 0, stop: 8 * BAR, take: 'A' }], 2 * BAR, 3 * BAR);
    expect(s).toEqual([{ start: 0, stop: 2 * BAR, take: 'A' }, { start: 3 * BAR, stop: 8 * BAR, take: 'A' }]);
  });

  it('a click switches the section under it to the clicked take, keeping its edges', () => {
    const s = [{ start: 0, stop: 2 * BAR, take: 'A' }, { start: 2 * BAR, stop: 4 * BAR, take: 'B' }];
    expect(L.clickChoose(s, 'C', 3 * BAR, { start: 0, stop: 8 * BAR })).toEqual([
      { start: 0, stop: 2 * BAR, take: 'A' },
      { start: 2 * BAR, stop: 4 * BAR, take: 'C' },
    ]);
  });

  it('a click in a gap fills the gap, as far as the take reaches; on an empty comp, the whole take', () => {
    const s = [{ start: 0, stop: 2 * BAR, take: 'A' }, { start: 6 * BAR, stop: 8 * BAR, take: 'A' }];
    expect(L.clickChoose(s, 'B', 3 * BAR, { start: BAR, stop: 5 * BAR })).toEqual([
      { start: 0, stop: 2 * BAR, take: 'A' },
      { start: 2 * BAR, stop: 5 * BAR, take: 'B' },
      { start: 6 * BAR, stop: 8 * BAR, take: 'A' },
    ]);
    expect(L.clickChoose([], 'B', 3 * BAR, { start: BAR, stop: 5 * BAR })).toEqual([{ start: BAR, stop: 5 * BAR, take: 'B' }]);
  });

  it('a swipe is kept inside the take', () => {
    expect(L.clampToExtent(5 * BAR, 0, { start: BAR, stop: 4 * BAR })).toEqual([BAR, 4 * BAR]);
    expect(L.clampToExtent(5 * BAR, 6 * BAR, { start: BAR, stop: 4 * BAR })).toBeUndefined();
  });

  it('segments from takes that are gone are dropped', () => {
    expect(L.prune([{ start: 0, stop: BAR, take: 'A' }, { start: BAR, stop: 2 * BAR, take: 'X' }], ['A'])).toEqual([{ start: 0, stop: BAR, take: 'A' }]);
  });
});

describe('dragging a section edge', () => {
  const two = [{ start: 0, stop: 4 * BAR, take: 'A' }, { start: 4 * BAR, stop: 8 * BAR, take: 'B' }];

  it('dragging the seam right grows the left section and shrinks the right one', () => {
    expect(L.moveEdge(two, two[0], 'stop', 5 * BAR)).toEqual([
      { start: 0, stop: 5 * BAR, take: 'A' },
      { start: 5 * BAR, stop: 8 * BAR, take: 'B' },
    ]);
  });

  it('dragging an edge inward lets the touching neighbour take up the space', () => {
    expect(L.moveEdge(two, two[1], 'start', 6 * BAR)).toEqual([
      { start: 0, stop: 6 * BAR, take: 'A' },
      { start: 6 * BAR, stop: 8 * BAR, take: 'B' },
    ]);
  });

  it('with nothing next to it, dragging inward opens a gap and dragging outward grows into empty space', () => {
    expect(L.moveEdge(two, two[1], 'stop', 7 * BAR)).toEqual([
      { start: 0, stop: 4 * BAR, take: 'A' },
      { start: 4 * BAR, stop: 7 * BAR, take: 'B' },
    ]);
    expect(L.moveEdge(two, two[0], 'start', -2 * BAR, { extent: { start: -BAR, stop: 9 * BAR } })[0]).toEqual({ start: -BAR, stop: 4 * BAR, take: 'A' });
  });

  it('a section never shrinks below its minimum or grows past its take', () => {
    expect(L.moveEdge(two, two[0], 'stop', 0, { minLen: 10 })[0]).toEqual({ start: 0, stop: 10, take: 'A' });
    expect(L.moveEdge(two, two[1], 'stop', 20 * BAR, { extent: { start: 0, stop: 9 * BAR } })[1]).toEqual({ start: 4 * BAR, stop: 9 * BAR, take: 'B' });
  });
});

describe('a base take', () => {
  it('on an empty comp, uses the whole take', () => {
    expect(L.fillGaps([], 'A', { start: BAR, stop: 9 * BAR })).toEqual([{ start: BAR, stop: 9 * BAR, take: 'A' }]);
  });

  it('fills only the gaps, keeping what was chosen', () => {
    const s = [{ start: 2 * BAR, stop: 3 * BAR, take: 'B' }, { start: 5 * BAR, stop: 6 * BAR, take: 'C' }];
    expect(L.fillGaps(s, 'A', { start: 0, stop: 8 * BAR })).toEqual([
      { start: 0, stop: 2 * BAR, take: 'A' },
      { start: 2 * BAR, stop: 3 * BAR, take: 'B' },
      { start: 3 * BAR, stop: 5 * BAR, take: 'A' },
      { start: 5 * BAR, stop: 6 * BAR, take: 'C' },
      { start: 6 * BAR, stop: 8 * BAR, take: 'A' },
    ]);
  });
});

describe('tidying tiny gaps and scraps', () => {
  // Ticks stand for ms here, to keep the numbers readable.
  const ms = (a, b) => b - a;
  const S = (start, stop, take) => ({ start, stop, take });
  const everywhere = () => ({ start: 0, stop: 100000 });

  it('finds gaps and sections shorter than 100 ms, and nothing longer', () => {
    const comp = [S(0, 1000, 'T3'), S(1050, 1053, 'T11'), S(1053, 2000, 'T20'), S(2300, 3000, 'T23')];
    const bits = L.tinyBits(comp, ms);
    expect(bits.map((b) => [b.kind, b.start, b.stop, b.ms, b.before, b.after])).toEqual([
      ['gap', 1000, 1050, 50, 'T3', 'T11'],
      ['scrap', 1050, 1053, 3, undefined, 'T20'],
    ]);
  });

  it('offers the touching takes that have audio there, and chooses none of them', () => {
    const comp = [S(0, 1000, 'A'), S(1040, 2000, 'B'), S(2000, 2050, 'C'), S(2050, 3000, 'B2')];
    const [gap, scrap] = L.tinyBits(comp, ms);
    expect(L.tidyTakes(gap, everywhere)).toEqual([{ take: 'A', ok: true }, { take: 'B', ok: true }]);
    const aEndsAt1000 = (t) => (t === 'A' ? { start: 0, stop: 1000 } : everywhere());
    expect(L.tidyTakes(gap, aEndsAt1000)).toEqual([{ take: 'A', ok: false }, { take: 'B', ok: true }]);
    expect(L.tidyTakes(scrap, everywhere).map((o) => o.take)).toEqual(['B', 'B2']);
  });

  it('fills a gap or a scrap with the take the user picks, or silences a scrap', () => {
    const comp = [S(0, 1000, 'A'), S(1040, 2000, 'B'), S(2000, 2050, 'C'), S(2050, 3000, 'D')];
    const [gap, scrap] = L.tinyBits(comp, ms);
    expect(L.fillBit(comp, gap, 'A')).toEqual([S(0, 1040, 'A'), S(1040, 2000, 'B'), S(2000, 2050, 'C'), S(2050, 3000, 'D')]);
    expect(L.fillBit(comp, gap, 'B')).toEqual([S(0, 1000, 'A'), S(1000, 2000, 'B'), S(2000, 2050, 'C'), S(2050, 3000, 'D')]);
    expect(L.fillBit(comp, scrap, 'D')).toEqual([S(0, 1000, 'A'), S(1040, 2000, 'B'), S(2000, 3000, 'D')]);
    expect(L.fillBit(comp, scrap, null)).toEqual([S(0, 1000, 'A'), S(1040, 2000, 'B'), S(2050, 3000, 'D')]);
  });

  it('applies only the choices made, the same whatever order they were picked in', () => {
    const comp = [S(0, 1000, 'A'), S(1020, 1025, 'C'), S(1025, 2000, 'B'), S(2000, 2040, 'E'), S(2040, 3000, 'F')];
    const [gap, c] = L.tinyBits(comp, ms);
    const choices = [{ bit: gap, use: 'A' }, { bit: c, use: 'A' }];   // E is left alone
    expect(L.tidy(comp, choices)).toEqual([S(0, 1025, 'A'), S(1025, 2000, 'B'), S(2000, 2040, 'E'), S(2040, 3000, 'F')]);
    expect(L.tidy(comp, [...choices].reverse())).toEqual(L.tidy(comp, choices));
  });
});

describe("LUNA's grid", () => {
  const bar = 4 * Luna.TICKS_PER_BEAT;
  it('reads the grid setting as a step in ticks, with triplets and dotted values', () => {
    expect(L.gridStep('1_16', 'normal', bar)).toBe(Luna.WHOLE_NOTE / 16);
    expect(L.gridStep('1_4', 'normal', bar)).toBe(Luna.QUARTER_NOTE);
    expect(L.gridStep('bar', 'normal', 3 * Luna.TICKS_PER_BEAT)).toBe(3 * Luna.TICKS_PER_BEAT);
    expect(L.gridStep('1_8', 'triplet', bar)).toBeCloseTo((Luna.WHOLE_NOTE / 8) * (2 / 3));
    expect(L.gridStep('1_8', 'dotted', bar)).toBe((Luna.WHOLE_NOTE / 8) * 1.5);
    expect(L.gridStep('something new', 'normal', bar)).toBeUndefined();
    expect([L.gridLabel('1_16', 'normal'), L.gridLabel('1_8', 'triplet'), L.gridLabel('bar', 'normal')]).toEqual(['1/16', '1/8T', 'Bar']);
  });
  it('snaps to the nearest grid line in the bar, the next downbeat included', () => {
    const q = Luna.QUARTER_NOTE;
    expect(L.snapInBar(1000 + q * 1.4, 1000, 1000 + bar, q)).toBe(1000 + q);
    expect(L.snapInBar(1000 + q * 3.8, 1000, 1000 + bar, q)).toBe(1000 + bar);
    // A dotted step that doesn't divide the bar: the last line before the bar end, or the end.
    expect(L.snapInBar(1000 + bar - 10, 1000, 1000 + bar, q * 1.5)).toBe(1000 + bar);
  });
});

describe("LUNA's markers on the ruler", () => {
  it('turns LUNA colours into CSS, lightened on request, with text that reads on them', () => {
    // A real marker colour from LUNA: 0xff51275a, a dark purple.
    expect(L.argbCss(0xff51275a)).toBe('rgba(81, 39, 90, 1)');
    expect(L.argbCss(0xff000000, 0.5, 0.5)).toBe('rgba(128, 128, 128, 0.5)');
    expect(L.textOn(0xff51275a)).toBe('#ffffff');
    expect(L.textOn(0xfff7c449)).toBe('#141414');
  });
  it('lays tags out in timeline order, each cut short where the next marker starts', () => {
    const tags = L.layoutTags([{ x: 300, want: 80, id: 'b' }, { x: 200, want: 150, id: 'a' }, { x: 302, want: 50, id: 'c' }], 1000);
    expect(tags.map((t) => [t.id, t.w])).toEqual([['a', 98], ['b', 4], ['c', 50]]);
    expect(L.layoutTags([{ x: 950, want: 120 }], 1000)[0].w).toBe(48);
  });
});

describe('what a playlist plays', () => {
  const clip = (id, start, stop, layer = 0) => ({ id, start: { value: start }, stop: { value: stop }, layer: { value: layer } });

  it('a clip on a higher layer hides the middle of one below', () => {
    const below = clip('a', 0, 10), above = clip('b', 4, 6, 1);
    expect(L.compile([below, above]).map((p) => [p.clip.id, p.start, p.stop])).toEqual([['a', 0, 4], ['b', 4, 6], ['a', 6, 10]]);
  });

  it('on the same layer the narrower clip wins', () => {
    expect(L.compile([clip('a', 0, 10), clip('b', 2, 3)]).map((p) => [p.clip.id, p.start, p.stop])).toEqual([['a', 0, 2], ['b', 2, 3], ['a', 3, 10]]);
  });
});

const realSessionCommand = L.sessionCommand;
async function sessionWithTakes({ count = 3 } = {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('s', { name: 'Demo', tracks: ['Vox'], packageUid: 'pkg' });
  engine.addSource('pkg', 'rec', { name: 'rec.wav', lengthNs: 120e9 });
  // The mock numbers clips per playlist (clip1 in every lane), so copying or deleting by uid
  // across playlists hits the wrong clip; LUNA's uids are unique in the session.
  let clipCounter = 0;
  engine.nextClipId = () => `clip${++clipCounter}`;
  // The mock's set_playlists answers without switching; make it switch, as LUNA does.
  engine.overrideCommand('/sessions/s/set_playlists', (data, e) => {
    for (const t of data.track_uid) {
      const pl = e.children('/sessions/s/playlists').find((p) =>
        e.value(`/sessions/s/playlists/${p}`, 'track_uid') === t && e.value(`/sessions/s/playlists/${p}`, 'version') === data.version);
      if (pl) e.setValue(`/sessions/s/tracks/${t}`, 'playlist_uid', pl);
    }
    return null;
  });
  // The mock has no set_playlist_name (and cannot be given one): catch it on the way out and
  // rename as LUNA does, the track and version picking the playlist.
  const renames = [];
  L.sessionCommand = (s, name, payload) => {
    if (name !== 'set_playlist_name') return realSessionCommand(s, name, payload);
    renames.push(payload);
    const pl = engine.children('/sessions/s/playlists').find((p) =>
      engine.value(`/sessions/s/playlists/${p}`, 'track_uid') === payload.track_uid && engine.value(`/sessions/s/playlists/${p}`, 'version') === payload.version);
    if (pl) engine.setValue(`/sessions/s/playlists/${pl}`, 'name', payload.name);
    return Promise.resolve(null);
  };
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.ready();
  await Promise.all([session.musical.ready(), session.playlists.load(), session.sources?.load(), L.store(session).load()]);
  const track = session.tracks.items[0];
  // Three takes (unless asked otherwise) of bars 1-9, recorded back to back in one file (as
  // loop recording does).
  for (let i = 1; i < count; i++) await session.newPlaylists([track.id]);
  await engine.settled();
  await session.playlists.membersReady();
  const lanes = L.playlistsOf(session, track);
  const t = session.musical.timeline, seconds = t.seconds(8 * BAR) - t.seconds(0);
  for (const [i, lane] of lanes.entries()) {
    await session.insertClip({ playlistUid: lane.id, sourceUid: 'rec', startTick: 0, stopTick: 8 * BAR, sourceStartNs: i * seconds * 1e9, sourceStopNs: (i + 1) * seconds * 1e9 });
  }
  await engine.settled();
  for (const lane of lanes) await lane.clips.load();
  return { engine, luna, session, track, lanes, t, renames };
}

describe('which edges a comp change fades', () => {
  const P = (a, b) => ({ startTick: a, stopTick: b });
  it('a comp built fresh fades in, crossfades every seam and fades out', () => {
    const pieces = [P(0, 10), P(10, 20), P(30, 40)];
    expect(L.fadeEdits(pieces, ['a', 'b', 'c'], [true, true, true], new Map())).toEqual([
      { kind: 'in', clip: 'a', at: 0, i: 0 },
      { kind: 'cross', left: 'a', right: 'b', at: 10, i: 0 },
      { kind: 'out', clip: 'b', at: 20, i: 1 },
      { kind: 'in', clip: 'c', at: 30, i: 2 },
      { kind: 'out', clip: 'c', at: 40, i: 2 },
    ]);
  });
  it('leaves the far edges of kept clips alone, and fades only around what changed', () => {
    // a and c stay; the middle is new (b2 replaces b).
    const pieces = [P(0, 10), P(10, 20), P(20, 30)];
    const before = new Map([['a', { left: null, right: 'b' }], ['c', { left: 'b', right: null }]]);
    expect(L.fadeEdits(pieces, ['a', 'b2', 'c'], [false, true, false], before)).toEqual([
      { kind: 'cross', left: 'a', right: 'b2', at: 10, i: 0 },
      { kind: 'cross', left: 'b2', right: 'c', at: 20, i: 1 },
    ]);
  });
  it('a kept clip whose neighbour was erased gets a fade-out where the silence starts', () => {
    const pieces = [P(0, 10), P(20, 30)];
    const before = new Map([['a', { left: null, right: 'b' }], ['c', { left: 'b', right: null }]]);
    expect(L.fadeEdits(pieces, ['a', 'c'], [false, false], before)).toEqual([
      { kind: 'out', clip: 'a', at: 10, i: 0 },
      { kind: 'in', clip: 'c', at: 20, i: 1 },
    ]);
  });
});

describe('undo and redo names', () => {
  // As LUNA lists them (read from a session on LUNA 3.1.2): "origin" first, by rowid, with gaps.
  const entries = [
    { rowid: 1, uid: 'o', name: 'origin' },
    { rowid: 416, uid: 'a', name: 'Mute Change' },
    { rowid: 418, uid: 'b', name: 'Swipe Comp' },
    { rowid: 420, uid: 'c', name: 'Move SwipeComp to the top' },
  ];
  it('names the step Undo takes back, and the one Redo puts back', () => {
    expect(L.undoSteps(entries, 'c', { canUndo: true, canRedo: false })).toEqual({ undo: 'Move SwipeComp to the top', redo: '' });
    expect(L.undoSteps(entries, 'b', { canUndo: true, canRedo: true })).toEqual({ undo: 'Swipe Comp', redo: 'Move SwipeComp to the top' });
  });
  it('names nothing at the start of the history or when the position is unknown', () => {
    expect(L.undoSteps(entries, 'o', { canUndo: false, canRedo: true })).toEqual({ undo: '', redo: 'Mute Change' });
    expect(L.undoSteps(entries, 'zzz')).toEqual({ undo: '', redo: '' });
  });
});

/** A bass DI and amp track in an edit group, three loop passes recorded together on both. */
async function groupSession({ extraAmpTake = false, recordedAmpTake = false } = {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('s', { name: 'Demo', tracks: ['DI', 'Amp'], packageUid: 'pkg' });
  engine.addSource('pkg', 'recDI', { name: 'DI.wav', lengthNs: 120e9 });
  engine.addSource('pkg', 'recAmp', { name: 'Amp.wav', lengthNs: 120e9 });
  let clipCounter = 0;
  engine.nextClipId = () => `clip${++clipCounter}`;
  engine.overrideCommand('/sessions/s/set_playlists', (data, e) => {
    for (const t of data.track_uid) {
      const pl = e.children('/sessions/s/playlists').find((p) =>
        e.value(`/sessions/s/playlists/${p}`, 'track_uid') === t && e.value(`/sessions/s/playlists/${p}`, 'version') === data.version);
      if (pl) e.setValue(`/sessions/s/tracks/${t}`, 'playlist_uid', pl);
    }
    return null;
  });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.ready();
  await Promise.all([session.musical.ready(), session.playlists.load(), session.sources?.load(), L.store(session).load()]);
  const [di, amp] = session.tracks.items;
  // LUNA's answer to group_affected_tracks with the group switched on (the mock has no groups).
  L.sessionCommand = (s, name, payload) => {
    if (name === 'group_affected_tracks') return Promise.resolve({ tracks: [di.id, amp.id] });
    return realSessionCommand(s, name, payload);
  };
  for (const t of [di, amp]) { await session.newPlaylists([t.id]); await session.newPlaylists([t.id]); }
  if (extraAmpTake || recordedAmpTake) await session.newPlaylists([amp.id]);   // a New Version on the amp only
  await engine.settled();
  await session.playlists.membersReady();
  const t = session.musical.timeline, seconds = t.seconds(8 * BAR) - t.seconds(0);
  for (const [track, src] of [[di, 'recDI'], [amp, 'recAmp']]) {
    const lanes = L.playlistsOf(session, track).slice(0, 3);
    for (const [i, lane] of lanes.entries()) {
      await session.insertClip({ playlistUid: lane.id, sourceUid: src, startTick: 0, stopTick: 8 * BAR, sourceStartNs: i * seconds * 1e9, sourceStopNs: (i + 1) * seconds * 1e9 });
    }
  }
  if (recordedAmpTake) {   // a fourth pass, recorded on the amp alone
    const lane = L.playlistsOf(session, amp)[3];
    await session.insertClip({ playlistUid: lane.id, sourceUid: 'recAmp', startTick: 0, stopTick: 8 * BAR, sourceStartNs: 3 * seconds * 1e9, sourceStopNs: 4 * seconds * 1e9 });
  }
  await engine.settled();
  for (const p of session.playlists.items) await p.clips.load();
  return { engine, session, di, amp };
}

// An instrument track with three MIDI takes of bars 1-4, each a different line, for MIDI comping.
const realContextCommand = L.contextCommand;
async function midiSession() {
  const engine = new Luna.MockEngine();
  engine.addSession('s', { name: 'Demo', tracks: ['Vox'], packageUid: 'pkg' });
  // The mock's set_playlists answers without switching; make it switch, as LUNA does.
  engine.overrideCommand('/sessions/s/set_playlists', (data, e) => {
    for (const t of data.track_uid) {
      const pl = e.children('/sessions/s/playlists').find((p) =>
        e.value(`/sessions/s/playlists/${p}`, 'track_uid') === t && e.value(`/sessions/s/playlists/${p}`, 'version') === data.version);
      if (pl) e.setValue(`/sessions/s/tracks/${t}`, 'playlist_uid', pl);
    }
    return null;
  });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.ready();
  await Promise.all([session.musical.ready(), session.playlists.load(), L.store(session).load()]);
  const [keys] = await session.newTrack({ name: 'Keys', trackType: 'instrument' });
  await engine.settled();
  await session.playlists.membersReady();
  for (let i = 1; i < 3; i++) await session.newPlaylists([keys.id]);
  await engine.settled();
  await session.playlists.membersReady();
  const lanes = L.playlistsOf(session, keys);
  for (const [i, lane] of lanes.entries()) {
    // Take i plays pitch 60 + i on every beat of bars 1-4.
    await lane.createNotes(Array.from({ length: 16 }, (_, k) => ({ pitch: 60 + i, startTick: k * BEAT, stopTick: (k + 1) * BEAT - BEAT / 4 })));
  }
  await engine.settled();
  for (const lane of lanes) await lane.clips.load();
  // LUNA's promote_takes (which the mock lacks): copy what a take has in a range into the track's
  // current playlist, notes in place, cut to the range, as measured on LUNA 3.1.2.
  const calls = [];
  let promoted = 0;
  L.contextCommand = (s2, name, payload) => {
    calls.push(name);
    if (name !== 'promote_takes') return realContextCommand(s2, name, payload);
    for (const pl of payload.playlist_uid) {
      const trackUid = engine.value(`/sessions/s/playlists/${pl}`, 'track_uid');
      const dest = String(engine.value(`/sessions/s/tracks/${trackUid}`, 'playlist_uid'));
      for (const c of engine.children(`/sessions/s/playlists/${pl}/clips`)) {
        const at = `/sessions/s/playlists/${pl}/clips/${c}`;
        const start = engine.value(at, 'start'), stop = engine.value(at, 'stop');
        const a = Math.max(start, payload.start), b = Math.min(stop, payload.stop);
        if (!(b > a)) continue;
        // A uid unique in the session, as LUNA's are (the mock numbers MIDI clips per playlist).
        const id = `promoted${++promoted}`, to = `/sessions/s/playlists/${dest}/clips/${id}`;
        engine.addNode(to, { properties: {
          uid: id, name: engine.value(at, 'name'), start: a, stop: b, source_uid: '', source_start: a, source_stop: b, clip_type: 2,
          gain: 0, bypass: false, render_source_uid: null, render_state: 'none', midi_source_start: engine.value(at, 'midi_source_start') + (a - start), layer: 0, mute: false,
        } });
        engine.addNode(`${to}/midi/table`, { properties: { row_data: engine.value(`${at}/midi/table`, 'row_data') } });
      }
    }
    return Promise.resolve(null);
  };
  return { engine, session, keys, lanes, calls };
}
const playedNotes = async (lane) => {
  await lane.clips.load();
  const out = [];
  for (const c of lane.clips.items) {
    await c.midi.ready();
    for (const n of c.midi.notes.items) {
      const on = c.start.value + n.startTick;
      if (on >= c.start.value && on < c.stop.value) out.push([on / BEAT, n.pitch]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
};

describe('warped comp clips', () => {
  it('asks before a change replaces a clip warped in LUNA, and not when the change leaves it', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    let list = L.applySwipe([], lanes[0].id, 0, 2 * BAR);
    list = L.applySwipe(list, lanes[1].id, 2 * BAR, 4 * BAR);
    await L.buildComp(session, track, comp, list);
    await L.setFadeMs(session, track, 10);   // as the page records it after every build
    await engine.settled();
    await comp.clips.load();
    const second = comp.clips.items.find((c) => c.start.value === 2 * BAR);
    const first = comp.clips.items.find((c) => c.start.value === 0);
    expect(await L.isWarped(session, second)).toBe(false);
    // A warp made in LUNA: a moved marker under the clip's warps (LUNA may also render the clip
    // anew, and later drop the rendering); its span and source offset stay.
    engine.addNode(`${second.path}/warps/537`, { properties: { rowid: 537, type: 'warp', warp_type: 0, start: 78e9, start_original: 124e9, source_start: 33e9, source_start_original: 33e9 } });
    await engine.settled();
    expect(await L.isWarped(session, second)).toBe(true);
    // A rendering alone counts too.
    engine.setValue(first.path, 'render_source_uid', 'rendered1');
    await engine.settled();
    expect(await L.isWarped(session, first)).toBe(true);
    engine.setValue(first.path, 'render_source_uid', '');
    await engine.settled();
    // A swipe elsewhere keeps the warped clip; one across it would replace it.
    expect(await L.warpedClipsReplaced(session, track, comp, L.applySwipe(list, lanes[2].id, 0, BAR))).toEqual([]);
    expect(await L.warpedClipsReplaced(session, track, comp, L.applySwipe(list, lanes[2].id, 3 * BAR, 5 * BAR))).toEqual([second]);
    // A new crossfade length rebuilds every clip, so it would replace it too.
    expect(await L.warpedClipsReplaced(session, track, comp, list, { fadeMs: 40 })).toEqual([second]);
  });
});

describe('sections from a warped take', () => {
  afterEach(() => { L.contextCommand = realContextCommand; });

  it("are copied by LUNA's promote_takes, crossfaded, kept by later changes, and not taken for the user's warps", async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    // Take 2 is warped in LUNA: a marker moved from where it was set.
    const takeClip = lanes[1].clips.items[0];
    engine.addNode(`${takeClip.path}/warps/589`, { properties: { rowid: 589, type: 'warp', warp_type: 0, start: 514e9, start_original: 576e9, source_start: 3.6e9, source_start_original: 3.6e9 } });
    await engine.settled();
    // promote_takes, which the mock lacks: copy the take's clip, cut to the range, into the
    // track's current playlist, warps and all, with a uid unique in the session.
    const calls = [];
    let promoted = 0;
    L.contextCommand = (s2, name, payload) => {
      calls.push(name);
      if (name !== 'promote_takes') return realContextCommand(s2, name, payload);
      for (const pl of payload.playlist_uid) {
        const dest = String(engine.value(`/sessions/s/tracks/${engine.value(`/sessions/s/playlists/${pl}`, 'track_uid')}`, 'playlist_uid'));
        for (const c of engine.children(`/sessions/s/playlists/${pl}/clips`)) {
          const from = `/sessions/s/playlists/${pl}/clips/${c}`, start = engine.value(from, 'start'), stop = engine.value(from, 'stop');
          const a = Math.max(start, payload.start), b = Math.min(stop, payload.stop);
          if (!(b > a)) continue;
          const id = `promoted${++promoted}`, to = `/sessions/s/playlists/${dest}/clips/${id}`;
          const props = Object.fromEntries(['name', 'source_uid', 'source_stop', 'clip_type', 'gain', 'bypass', 'render_state', 'midi_source_start', 'layer', 'mute'].map((k) => [k, engine.value(from, k)]));
          engine.addNode(to, { properties: { ...props, uid: id, start: a, stop: b, source_start: engine.value(from, 'source_start') + (a - start) / BAR * 1e9, render_source_uid: '' } });
          engine.addNode(`${to}/warps/9${promoted}`, { properties: { rowid: 900 + promoted, type: 'warp', warp_type: 0, start: 1e9, start_original: 2e9, source_start: 3.6e9, source_start_original: 3.6e9 } });
        }
      }
      return Promise.resolve(null);
    };
    const comp = await L.ensureCompLane(session, track);
    let list = L.applySwipe([], lanes[0].id, 0, 2 * BAR);
    list = L.applySwipe(list, lanes[1].id, 2 * BAR, 4 * BAR);
    await L.buildComp(session, track, comp, list);
    await L.setFadeMs(session, track, 10);
    await engine.settled();
    await comp.clips.load();
    expect(calls.filter((c) => c === 'promote_takes')).toHaveLength(1);
    expect(comp.clips.items.map((c) => [c.start.value / BAR, c.stop.value / BAR, c.id.startsWith('promoted')]).sort()).toEqual([[0, 2, false], [2, 4, true]]);
    const made = comp.clips.items.find((c) => c.id.startsWith('promoted'));
    expect(L.foreignClips(session, comp, track)).toEqual([]);
    expect(L.madeByLuna(session, track, comp)).toEqual([made]);
    expect(L.misnamedCompClips(session, comp, list).map((m) => m.clip)).not.toContain(made);
    // Found inside the change: named after its take and recorded by id as LUNA's.
    expect(made.name.value).toBe(lanes[1].name.value);
    expect(L.store(session).value(track.id, 'placed').value.find((r) => r.byLuna)).toMatchObject({ id: made.id, byLuna: true });
    // A later change elsewhere keeps it (no second copy), and the warp guard does not take the
    // take's own warps for the user's, even for a change across it.
    calls.length = 0;
    const later = L.applySwipe(L.savedSegments(session, track), lanes[2].id, 6 * BAR, 7 * BAR);
    expect(await L.warpedClipsReplaced(session, track, comp, later)).toEqual([]);
    expect(await L.warpedClipsReplaced(session, track, comp, L.applySwipe(list, lanes[2].id, 3 * BAR, 5 * BAR))).toEqual([]);
    await L.buildComp(session, track, comp, later);
    await engine.settled();
    await comp.clips.load();
    expect(calls.includes('promote_takes')).toBe(false);
    expect(comp.clips.items).toContain(made);
  });
});

describe('comping MIDI', () => {
  afterEach(() => { L.contextCommand = realContextCommand; });

  it('counts an instrument track as comp-able, even with one take', async () => {
    const { session, keys } = await midiSession();
    expect(L.isMidiTrack(keys)).toBe(true);
    expect(L.compableTracks(session)).toContain(keys);
  });

  it("copies each section's notes in place from its own take, with no fades, as one undo step", async () => {
    const { engine, session, keys, lanes, calls } = await midiSession();
    const comp = await L.ensureCompLane(session, keys);
    let list = L.applySwipe([], lanes[0].id, 0, 4 * BEAT);
    list = L.applySwipe(list, lanes[2].id, 4 * BEAT, 6 * BEAT);
    engine.transactions.length = 0;
    await L.buildComp(session, keys, comp, list);
    await engine.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(calls.filter((c) => c === 'promote_takes')).toHaveLength(2);
    expect(calls.some((c) => c === 'set_fade' || c === 'delete_fades')).toBe(false);
    // Beats 0-3 from take 1 (pitch 60), beats 4-5 from take 3 (pitch 62), nothing after.
    expect(await playedNotes(comp)).toEqual([[0, 60], [1, 60], [2, 60], [3, 60], [4, 62], [5, 62]]);
    // The page knows these clips as its own, though LUNA made them.
    expect(L.foreignClips(session, comp, keys)).toEqual([]);
  });

  it('rewrites the whole comp on a change', async () => {
    const { session, keys, lanes } = await midiSession();
    const comp = await L.ensureCompLane(session, keys);
    await L.buildComp(session, keys, comp, L.applySwipe([], lanes[1].id, 0, 8 * BEAT));
    await L.buildComp(session, keys, comp, L.applySwipe(L.savedSegments(session, keys), lanes[0].id, 2 * BEAT, 3 * BEAT));
    expect((await playedNotes(comp)).map(([, p]) => p)).toEqual([61, 61, 60, 61, 61, 61, 61, 61]);
  });
});

describe('comping an edit group', () => {
  it("finds the group's other tracks as LUNA reports them", async () => {
    const { session, di, amp } = await groupSession();
    expect(await L.groupMates(session, di)).toEqual([amp]);
  });

  it('pairs takes in order (take 1 with take 1), not counting an empty extra take on one track', async () => {
    const { session, di, amp } = await groupSession({ extraAmpTake: true });
    const map = L.matchTakes(session, di, amp);
    const d = L.takesOf(session, di), a = L.takesOf(session, amp).filter((p) => p.clips.items.length);
    expect(L.recordedTakes(session, amp)).toHaveLength(3);
    expect([...map.entries()]).toEqual(d.map((p, i) => [p.id, a[i].id]));
  });

  it("matches nothing when the tracks' take counts differ (Logic's rule)", async () => {
    const { session, di, amp } = await groupSession({ recordedAmpTake: true });
    expect(L.recordedTakes(session, di)).toHaveLength(3);
    expect(L.recordedTakes(session, amp)).toHaveLength(4);
    expect(L.matchTakes(session, di, amp).size).toBe(0);
  });

  it('lets the group comp only when every track has the same number of takes', async () => {
    const even = await groupSession({ extraAmpTake: true });   // an empty extra take doesn't count
    expect(L.groupTakeCheck(even.session, even.di, [even.amp])).toEqual({ lead: 3, counts: [{ track: even.amp, count: 3 }], same: true });
    const odd = await groupSession({ recordedAmpTake: true });
    const check = L.groupTakeCheck(odd.session, odd.di, [odd.amp]);
    expect(check.same).toBe(false);
    expect(check.counts.map((c) => c.count)).toEqual([4]);
  });

  it("reads LUNA's group list: which groups the track is in, switched on or not, with Edit or not", () => {
    const group = (uid, name, attrs, ids) => ({
      properties: { uid: { value: uid }, name: { value: name }, group_attributes: { value: attrs } },
      children: [{ path: 'members', children: ids.map((id) => ({ properties: { track_uid: { value: id } } })) }],
    });
    const node = { children: [group('g1', 'Drums', 'edit,mix', ['k', 's', 'oh']), group('g2', 'Vox', 'mix', ['v1', 'v2']), group('g3', 'All', 'edit', ['k', 'v1'])] };
    expect(L.readGroups(node, ['g1'], 'k')).toEqual([
      { uid: 'g1', name: 'Drums', on: true, edit: true, trackIds: ['s', 'oh'] },
      { uid: 'g3', name: 'All', on: false, edit: true, trackIds: ['v1'] },
    ]);
    expect(L.readGroups(node, ['g1'], 'nobody')).toEqual([]);
  });

  it('comps a group with Edit on only together, and asks about a group without it', () => {
    const g = (on, edit, trackIds, name = 'G') => ({ uid: name, name, on, edit, trackIds });
    expect(L.groupPlan([g(true, true, ['a', 'b'], 'Drums')], ['a', 'b'])).toEqual({ mode: 'edit', trackIds: ['a', 'b'], names: ['Drums'] });
    // LUNA's answer first; the group list when LUNA gives none.
    expect(L.groupPlan([g(true, true, ['a'], 'Drums')], [])).toEqual({ mode: 'edit', trackIds: ['a'], names: ['Drums'] });
    // Switched off, or switched on without Edit: the user chooses.
    expect(L.groupPlan([g(false, true, ['a'], 'BGVs'), g(true, false, ['b', 'a'], 'Mix')], [])).toEqual({ mode: 'ask', trackIds: ['a', 'b'], names: ['BGVs', 'Mix'] });
    expect(L.groupPlan([], [])).toEqual({ mode: 'none', trackIds: [], names: [] });
  });

  it('builds the same sections on every grouped track from its own takes, as one undo step', async () => {
    const { engine, session, di, amp } = await groupSession();
    const diComp = await L.ensureCompLane(session, di);
    const map = L.matchTakes(session, di, amp);
    const [d1, d2] = L.takesOf(session, di).filter((p) => p !== diComp);
    let list = L.applySwipe([], d1.id, 0, 4 * BAR);
    list = L.applySwipe(list, d2.id, 4 * BAR, 8 * BAR);
    engine.transactions.length = 0;
    const lanes = await L.buildGroupComp(session, di, diComp, [{ track: amp, lane: undefined, map }], list);
    await engine.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    const ampComp = lanes[1];
    expect(ampComp.name.value).toBe(L.COMP_NAME);
    expect(L.compLaneOf(session, amp)).toBe(ampComp);
    for (const lane of lanes) await lane.clips.load();
    const edges = (lane) => [...lane.clips.items].sort((a, b) => a.start.value - b.start.value).map((c) => [c.start.value, c.stop.value]);
    expect(edges(ampComp)).toEqual(edges(diComp));
    expect(L.savedSegments(session, amp).map((s) => s.take)).toEqual([map.get(d1.id), map.get(d2.id)]);
    const src = (lane) => [...lane.clips.items].sort((a, b) => a.start.value - b.start.value).map((c) => Math.round(c.sourceStart.value / 1e6));
    expect(src(ampComp)).toEqual(src(diComp));   // the same moment of each pass on both tracks
  });

  it('maps sections into a grouped track, dropping those with no matching take', () => {
    const map = new Map([['a', 'A']]);
    expect(L.mapSegments([{ take: 'a', start: 0, stop: 5 }, { take: 'b', start: 5, stop: 9 }], map)).toEqual([{ take: 'A', start: 0, stop: 5 }]);
  });
});

describe('play and stop', () => {
  it('starts from the left edge of the screen when the playhead is off screen, and stops when playing', async () => {
    const { engine, session } = await sessionWithTakes();
    expect(session.transport.tick).toBe(0);
    await L.playOrStop(session, 4 * BAR, 8 * BAR);
    await engine.settled();
    expect(session.transport.playing.value).toBe(true);
    expect(session.transport.tick).toBe(4 * BAR);
    await L.playOrStop(session, 4 * BAR, 8 * BAR);
    await engine.settled();
    expect(session.transport.playing.value).toBe(false);
  });

  it('starts from the playhead when it is on screen', async () => {
    const { engine, session } = await sessionWithTakes();
    await session.transport.seek(5 * BAR);
    await engine.settled();
    const seeksBefore = engine.requests.length;
    await L.playOrStop(session, 4 * BAR, 8 * BAR);
    await engine.settled();
    expect(session.transport.tick).toBe(5 * BAR);
    expect(engine.requests.slice(seeksBefore).some((r) => /seek|play_start|locate/.test(r.path))).toBe(false);
  });
});

describe('building the comp', () => {
  it('makes a SwipeComp playlist and fills it with the right part of each take, as one undo step', async () => {
    const { engine, session, track, lanes, t } = await sessionWithTakes();
    const [A, B] = lanes;
    const comp = await L.ensureCompLane(session, track);
    await engine.settled();
    expect(L.takesOf(session, track)).toHaveLength(3);
    expect(L.compLaneOf(session, track)).toBe(comp);

    let list = L.applySwipe([], A.id, 0, 4 * BAR);
    list = L.applySwipe(list, B.id, 4 * BAR, 8 * BAR);
    engine.transactions.length = 0;
    const n = await L.buildComp(session, track, comp, list, { fadeMs: 10 });
    await engine.settled();
    expect(n).toBe(2);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(session.playlistFor(track)).toBe(comp);

    await comp.clips.load();
    const clips = [...comp.clips.items].sort((a, b) => a.start.value - b.start.value);
    expect(clips.map((c) => [c.start.value, c.stop.value])).toEqual([[0, 4 * BAR], [4 * BAR, 8 * BAR]]);
    // Take B's audio at bar 5 is one take-length into the file plus four bars.
    const bStart = (t.seconds(8 * BAR) - t.seconds(0) + t.seconds(4 * BAR) - t.seconds(0)) * 1e9;
    expect(Math.abs(clips[1].sourceStart.value - bStart)).toBeLessThan(1000);
    expect(L.savedSegments(session, track)).toEqual(list);
  });

  it('comps a track with one take: keeps the parts swiped, silent between, as one undo step', async () => {
    const { engine, session, track, lanes, t } = await sessionWithTakes({ count: 1 });
    expect(lanes).toHaveLength(1);
    expect(L.compableTracks(session)).toContain(track);
    const [only] = lanes;
    const comp = await L.ensureCompLane(session, track);
    await engine.settled();
    expect(L.takesOf(session, track)).toEqual([only]);

    // Keep the first two bars and bars 5 to 7 of the one take; bars 3 and 4 go silent.
    let list = L.applySwipe([], only.id, 0, 2 * BAR);
    list = L.applySwipe(list, only.id, 4 * BAR, 7 * BAR);
    engine.transactions.length = 0;
    const n = await L.buildComp(session, track, comp, list, { fadeMs: 10 });
    await engine.settled();
    expect(n).toBe(2);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(session.playlistFor(track)).toBe(comp);
    await comp.clips.load();
    const clips = [...comp.clips.items].sort((a, b) => a.start.value - b.start.value);
    expect(clips.map((c) => [c.start.value, c.stop.value])).toEqual([[0, 2 * BAR], [4 * BAR, 7 * BAR]]);
    // Each piece plays the take's own audio at that point of the timeline.
    expect(Math.abs(clips[1].sourceStart.value - (t.seconds(4 * BAR) - t.seconds(0)) * 1e9)).toBeLessThan(1000);
    // Silence the middle of the second part: it splits in two.
    expect(L.clearRange(list, 5 * BAR, 6 * BAR).map((s) => [s.start, s.stop])).toEqual([[0, 2 * BAR], [4 * BAR, 5 * BAR], [6 * BAR, 7 * BAR]]);
  });

  it("names each comp clip after its take, and renaming a take renames its comp clips, in one undo step", async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const [A, B] = lanes;
    const comp = await L.ensureCompLane(session, track);
    let list = L.applySwipe([], A.id, 0, 4 * BAR);
    list = L.applySwipe(list, B.id, 4 * BAR, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await engine.settled();
    await comp.clips.load();
    const byStart = () => [...comp.clips.items].sort((a, b) => a.start.value - b.start.value).map((c) => c.name.value);
    expect(byStart()).toEqual([A.name.value, B.name.value]);

    engine.transactions.length = 0;
    expect(await L.renameTake(session, B, '  Big ending  ', comp, list)).toBe(true);
    await engine.settled();
    expect(B.name.value).toBe('Big ending');
    expect(byStart()).toEqual([A.name.value, 'Big ending']);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(await L.renameTake(session, B, '   ', comp, list)).toBe(false);
  });

  it("touches only the comped track: no playlist command carries LUNA's edit context (which would reach its edit group)", async () => {
    const { engine, session, track, lanes, renames } = await sessionWithTakes();
    const from = engine.requests.length;
    const comp = await L.ensureCompLane(session, track);
    const list = L.applySwipe([], lanes[1].id, 0, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await L.renameTake(session, lanes[1], 'Keeper', comp, list);
    await L.showPlaylist(session, track.id, lanes[0].version.value);
    await engine.settled();
    const posts = engine.requests.slice(from).filter((r) => /\/(set_playlists|new_playlists)$/.test(r.path)).map((r) => r.data);
    expect(posts.length).toBe(3);   // the new SwipeComp, switching to it, switching back
    for (const data of [...posts, ...renames]) {
      expect(data.context_type).toBeUndefined();
      expect([].concat(data.track_uid)).toEqual([track.id]);
    }
    expect(renames).toEqual([{ track_uid: track.id, version: lanes[1].version.value, name: 'Keeper' }]);
    expect(lanes[1].name.value).toBe('Keeper');
  });

  it('knows which take each comp clip came from by its own record, even when the saved sections disagree', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const [A, B] = lanes;
    const comp = await L.ensureCompLane(session, track);
    let list = L.applySwipe([], A.id, 0, 4 * BAR);
    list = L.applySwipe(list, B.id, 4 * BAR, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await engine.settled();
    await comp.clips.load();
    expect(L.store(session).value(track.id, 'placed').value.map((p) => p.take)).toEqual([A.id, B.id]);
    // Say the sections arrive ahead of the clips after an undo: all of it from A.
    const allA = L.applySwipe([], A.id, 0, 8 * BAR);
    expect(L.misnamedCompClips(session, comp, allA)).toEqual([]);
    expect(await L.nameCompClips(session, comp, allA)).toBe(0);
  });

  it('a swipe keeps the comp clips it does not change, with what was done to them in LUNA', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const [A, B, C] = lanes;
    const comp = await L.ensureCompLane(session, track);
    let list = L.applySwipe([], A.id, 0, 4 * BAR);
    list = L.applySwipe(list, B.id, 4 * BAR, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await L.setFadeMs(session, track, 10);
    await engine.settled();
    await comp.clips.load();
    const clipA = [...comp.clips.items].find((c) => c.start.value === 0);
    engine.setValue(clipA.path, 'gain', 0.5);   // say the clip gain was changed in LUNA
    await engine.settled();
    const from = engine.requests.length;
    engine.transactions.length = 0;
    // Swipe C over the end: A's piece is untouched, B's is shortened, C's is new.
    list = L.applySwipe(list, C.id, 6 * BAR, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await engine.settled();
    await comp.clips.load();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    const now = [...comp.clips.items].sort((a, b) => a.start.value - b.start.value);
    expect(now.map((c) => [c.start.value, c.stop.value])).toEqual([[0, 4 * BAR], [4 * BAR, 6 * BAR], [6 * BAR, 8 * BAR]]);
    expect(now[0].id).toBe(clipA.id);
    expect(now[0].gain.value).toBe(0.5);
    const posted = engine.requests.slice(from).map((r) => r.path.split('/').pop());
    expect(posted).not.toContain('batch_fades');
    const fades = engine.requests.slice(from).find((r) => r.path.endsWith('/set_fade')).data.clips;
    // No new fade at A's start: whatever fade it has there stays.
    expect(fades.map((f) => [f.fade_type, f.clip_uid === clipA.id ? 'A' : 'new'])).toEqual([
      ['cross_fade', 'A'], ['cross_fade', 'new'], ['fade_out', 'new'],
    ]);
    expect(L.store(session).value(track.id, 'placed').value.map((p) => p.take)).toEqual([A.id, B.id, C.id]);
  });

  it('a new crossfade length rebuilds every seam', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    const list = L.applySwipe([], lanes[0].id, 0, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await L.setFadeMs(session, track, 10);
    await engine.settled();
    const from = engine.requests.length;
    await L.buildComp(session, track, comp, L.applySwipe(list, lanes[1].id, 2 * BAR, 3 * BAR), { fadeMs: 25 });
    await engine.settled();
    const posted = engine.requests.slice(from).map((r) => r.path.split('/').pop());
    expect(posted).toContain('batch_fades');
    expect(posted).not.toContain('set_fade');
  });

  it('names the clips of a comp built before clips were named', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    const list = L.applySwipe([], lanes[1].id, 0, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await engine.settled();
    await comp.clips.load();
    await comp.clips.items[0].name.set('Vox_1');
    await engine.settled();
    expect(L.misnamedCompClips(session, comp, list)).toHaveLength(1);
    expect(await L.nameCompClips(session, comp, list)).toBe(1);
    await engine.settled();
    expect(comp.clips.items[0].name.value).toBe(lanes[1].name.value);
    expect(await L.nameCompClips(session, comp, list)).toBe(0);
  });

  it("leaves the user's own playlist called \"Comp\" alone: it is a take, and the page makes its own SwipeComp", async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const mine = lanes[2];
    await mine.property('name').set('Comp');
    await engine.settled();
    expect(L.compLaneOf(session, track)).toBeUndefined();
    expect(L.takesOf(session, track)).toContain(mine);
    const comp = await L.ensureCompLane(session, track);
    await engine.settled();
    expect(comp).not.toBe(mine);
    expect(comp.name.value).toBe('SwipeComp');
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[0].id, 0, 8 * BAR));
    await engine.settled();
    await mine.clips.load();
    expect(mine.clips.items).toHaveLength(1);
    expect(mine.name.value).toBe('Comp');
  });

  it('when the SwipeComp playlist is deleted, the saved sections survive and a rebuild makes a new one', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    const list = L.applySwipe([], lanes[1].id, 0, 8 * BAR);
    await L.buildComp(session, track, comp, list);
    await engine.settled();
    engine.removeNode(`/sessions/s/playlists/${comp.id}`);
    await engine.settled();
    await session.playlists.membersReady();
    expect(L.compLaneOf(session, track)).toBeUndefined();
    expect(L.savedSegments(session, track)).toEqual(list);
    const again = await L.ensureCompLane(session, track);
    await L.buildComp(session, track, again, L.savedSegments(session, track));
    await engine.settled();
    await again.clips.load();
    expect(again).not.toBe(comp);
    expect(L.compLaneOf(session, track)).toBe(again);
    expect(again.clips.items).toHaveLength(1);
  });

  it('notices a clip on the comp that the page did not put there, and a moved one', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[0].id, 0, 4 * BAR));
    await engine.settled();
    await comp.clips.load();
    expect(L.foreignClips(session, comp, track)).toEqual([]);
    // A "recording" lands on the comp playlist.
    await session.insertClip({ playlistUid: comp.id, sourceUid: 'rec', startTick: 6 * BAR, stopTick: 7 * BAR, sourceStartNs: 0, sourceStopNs: 1e9 });
    await engine.settled();
    await comp.clips.load();
    expect(L.foreignClips(session, comp, track)).toHaveLength(1);
    // The next build records everything on the comp as its own again.
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[1].id, 0, 2 * BAR));
    await engine.settled();
    await comp.clips.load();
    expect(L.foreignClips(session, comp, track)).toEqual([]);
  });

  it('keeps SwipeComp at the top of the take numbers when newer takes arrive, as part of the next build', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);   // take 4
    await session.newPlaylists([track.id]);                  // a newer take, 5
    await session.newPlaylists([track.id]);                  // and 6
    await engine.settled();
    await session.playlists.membersReady();
    const [t5, t6] = L.playlistsOf(session, track).filter((p) => p.version.value > comp.version.value);
    const [n5, n6] = [t5.name.value, t6.name.value];
    expect(L.compBelowNewer(session, track, comp)).toBe(true);
    engine.transactions.length = 0;
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[0].id, 0, 8 * BAR));
    await engine.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(comp.version.value).toBe(6);
    expect([t5.version.value, t6.version.value]).toEqual([4, 5]);
    expect([t5.name.value, t6.name.value]).toEqual([n5, n6]);
    const versions = L.playlistsOf(session, track).map((p) => p.version.value);
    expect(new Set(versions).size).toBe(versions.length);
    expect(L.compBelowNewer(session, track, comp)).toBe(false);
    expect(await L.keepCompOnTop(session, track, comp)).toBe(false);
  });

  it('"Leave it here" keeps SwipeComp below a newer take through later builds, until "Move to top"', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);   // take 4
    await session.newPlaylists([track.id]);                  // a newer take, 5
    await engine.settled();
    await session.playlists.membersReady();
    const [t5] = L.playlistsOf(session, track).filter((p) => p.version.value > comp.version.value);
    expect(L.keepsOnTop(session, track)).toBe(true);
    await L.setKeepOnTop(session, track, false);
    await engine.settled();
    expect(L.keepsOnTop(session, track)).toBe(false);
    // Swiping from the new take leaves the numbers alone.
    await L.buildComp(session, track, comp, L.applySwipe([], t5.id, 0, 8 * BAR));
    await engine.settled();
    expect([comp.version.value, t5.version.value]).toEqual([4, 5]);
    expect(L.compBelowNewer(session, track, comp)).toBe(true);
    // "Move to top" moves it in one undo step and keeps it on top again.
    engine.transactions.length = 0;
    expect(await L.keepCompOnTop(session, track, comp)).toBe(true);
    await engine.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect([comp.version.value, t5.version.value]).toEqual([5, 4]);
    expect(L.keepsOnTop(session, track)).toBe(true);
    // The next newer take is moved under SwipeComp at the next build, as before.
    await session.newPlaylists([track.id]);
    await engine.settled();
    await session.playlists.membersReady();
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[0].id, 0, 8 * BAR));
    await engine.settled();
    expect(L.compBelowNewer(session, track, comp)).toBe(false);
  });

  it("remembers each track's crossfade length in the session", async () => {
    const { engine, session, track } = await sessionWithTakes();
    expect(L.savedFadeMs(session, track)).toBeUndefined();
    await L.setFadeMs(session, track, 30);
    await engine.settled();
    expect(L.savedFadeMs(session, track)).toBe(30);
    await L.setFadeMs(session, track, 12);
    await engine.settled();
    expect(engine.value(`/sessions/s/storage/${L.STORE}/${track.id}`, 'fadeMs')).toBe(12);
  });

  it('the choice is kept per track, in the session', async () => {
    const { engine, session, track } = await sessionWithTakes();
    await L.setKeepOnTop(session, track, false);
    await engine.settled();
    expect(engine.value(`/sessions/s/storage/${L.STORE}/${track.id}`, 'onTop')).toBe(false);
    await L.setKeepOnTop(session, track, true);
    await engine.settled();
    expect(L.keepsOnTop(session, track)).toBe(true);
  });

  it('Clear comp with no comp playlist forgets the sections without making one', async () => {
    const { engine, session, track } = await sessionWithTakes();
    const before = session.playlists.items.length;
    await L.clearSaved(session, track);
    await engine.settled();
    expect(L.savedSegments(session, track)).toEqual([]);
    expect(session.playlists.items.length).toBe(before);
  });

  it('a rebuild replaces the old comp rather than adding to it', async () => {
    const { engine, session, track, lanes } = await sessionWithTakes();
    const comp = await L.ensureCompLane(session, track);
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[0].id, 0, 8 * BAR));
    await L.buildComp(session, track, comp, L.applySwipe([], lanes[2].id, 0, 2 * BAR));
    await engine.settled();
    await comp.clips.load();
    expect(comp.clips.items.map((c) => [c.start.value, c.stop.value])).toEqual([[0, 2 * BAR]]);
  });
});
