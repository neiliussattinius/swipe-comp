// Swipe Comping: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// The comp is a list of segments, each { start, stop, take }: ticks on the timeline and the uid
// of the take (playlist) chosen for that stretch. Swiping edits the list (pure functions below);
// buildComp() then rewrites the track's "SwipeComp" playlist from the list as one undo step: one clip
// per piece of take audio, crossfaded wherever two pieces meet. The list itself is kept in the
// session's storage inside that same undo step, so Cmd+Z in LUNA takes back both together.

const AddOnLogic = {
  STORE: 'com.neilsattin.swipe_comp',
  // A name of its own, so a playlist the user made and called "Comp" is never mistaken for it.
  COMP_NAME: 'SwipeComp',
  // How far apart two clip edges can be and still be the same edge: a ten-thousandth of a beat
  // (about 50 microseconds at 120 bpm), far shorter than any section. LUNA places what it copies
  // a little off the ticks asked for (40 to 80 ticks, 11/23: a promoted warped section; a sample is
  // about 5 million ticks), so an exact match took the page's own warped comp clips for foreign
  // ones and asked before every swipe.
  SLACK: Luna.TICKS_PER_BEAT / 10000,

  // ── the comp list ──────────────────────────────────────────────────────────────────────

  /** Join neighbours that touch and come from the same take; drop empty segments. */
  merge(segments) {
    const out = [];
    for (const s of [...segments].sort((x, y) => x.start - y.start)) {
      if (s.stop <= s.start) continue;
      const last = out[out.length - 1];
      if (last && last.take === s.take && last.stop === s.start) last.stop = s.stop;
      else out.push({ start: s.start, stop: s.stop, take: s.take });
    }
    return out;
  },

  /** Choose `take` for ticks a..b (either order), replacing whatever was chosen there. */
  applySwipe(segments, take, a, b) {
    const start = Math.min(a, b), stop = Math.max(a, b);
    if (stop <= start) return AddOnLogic.merge(segments);
    const out = [];
    for (const s of segments) {
      if (s.stop <= start || s.start >= stop) { out.push({ ...s }); continue; }
      if (s.start < start) out.push({ ...s, stop: start });
      if (s.stop > stop) out.push({ ...s, start: stop });
    }
    out.push({ start, stop, take });
    return AddOnLogic.merge(out);
  },

  /**
   * Drag one edge of section `sec` ('start' or 'stop') to `tick`, as grabbing it does.
   * Outward, the section grows over whatever is there. Inward, a section touching that edge
   * grows into the space, or a gap opens. A section keeps at least `minLen`, and grows no
   * further than its take's audio (`extent`).
   */
  moveEdge(segments, sec, side, tick, { extent, minLen = 1 } = {}) {
    const list = segments.map((s) => ({ ...s }));
    const s = list.find((x) => x.start === sec.start && x.stop === sec.stop && x.take === sec.take);
    if (!s) return AddOnLogic.merge(list);
    if (side === 'start') {
      let t = Math.min(Math.round(tick), s.stop - minLen);
      if (extent) t = Math.max(t, extent.start);
      if (t < s.start) return AddOnLogic.applySwipe(list, s.take, t, s.start);
      if (t > s.start) {
        const prev = list.find((p) => p.stop === s.start);
        return prev ? AddOnLogic.applySwipe(list, prev.take, s.start, t) : AddOnLogic.clearRange(list, s.start, t);
      }
      return AddOnLogic.merge(list);
    }
    let t = Math.max(Math.round(tick), s.start + minLen);
    if (extent) t = Math.min(t, extent.stop);
    if (t > s.stop) return AddOnLogic.applySwipe(list, s.take, s.stop, t);
    if (t < s.stop) {
      const next = list.find((n) => n.start === s.stop);
      return next ? AddOnLogic.applySwipe(list, next.take, t, s.stop) : AddOnLogic.clearRange(list, t, s.stop);
    }
    return AddOnLogic.merge(list);
  },

  /**
   * Use `take` as the base: fill every stretch of its audio where the comp has nothing chosen.
   * On an empty comp that is the whole take; sections already chosen are kept.
   */
  fillGaps(segments, take, extent) {
    if (!extent) return AddOnLogic.merge(segments);
    const out = segments.map((s) => ({ ...s }));
    let cursor = extent.start;
    for (const s of AddOnLogic.merge(segments)) {
      if (cursor >= extent.stop) break;
      if (s.start > cursor) out.push({ start: cursor, stop: Math.min(s.start, extent.stop), take });
      cursor = Math.max(cursor, s.stop);
    }
    if (cursor < extent.stop) out.push({ start: cursor, stop: extent.stop, take });
    return AddOnLogic.merge(out);
  },

  /** Take nothing for ticks a..b. */
  clearRange(segments, a, b) {
    const start = Math.min(a, b), stop = Math.max(a, b), out = [];
    for (const s of segments) {
      if (s.stop <= start || s.start >= stop) { out.push({ ...s }); continue; }
      if (s.start < start) out.push({ ...s, stop: start });
      if (s.stop > stop) out.push({ ...s, start: stop });
    }
    return AddOnLogic.merge(out);
  },

  /**
   * A click on `take` at `tick`, as in Logic: where the comp already has a section, that
   * section switches to this take with its edges kept; in a gap, the take fills the gap (as far
   * as its audio reaches), so a first click on a take uses all of it.
   */
  clickChoose(segments, take, tick, extent) {
    const hit = segments.find((s) => s.start <= tick && tick < s.stop);
    if (hit) return AddOnLogic.merge(segments.map((s) => (s === hit ? { ...s, take } : { ...s })));
    if (!extent) return AddOnLogic.merge(segments);
    let a = extent.start, b = extent.stop;
    for (const s of segments) {
      if (s.stop <= tick) a = Math.max(a, s.stop);
      if (s.start > tick) b = Math.min(b, s.start);
    }
    return b > a ? AddOnLogic.applySwipe(segments, take, a, b) : AddOnLogic.merge(segments);
  },

  // ── tidying tiny gaps and scraps ─────────────────────────────────────────────────────────

  /** Shorter than this many ms, a gap between sections, or a section, counts as tiny. */
  TINY_MS: 100,

  /**
   * Tiny gaps between comp sections, and tiny sections ("scraps"): what a swipe leaves when it
   * stops just short of a neighbour, or just past one. `ms(a, b)` is the time in ms from tick
   * a to tick b. Each has a `key` that stays the same while the comp around it does, and
   * `before`/`after`: the takes of the sections touching it (undefined where nothing touches).
   */
  tinyBits(segments, ms, maxMs = AddOnLogic.TINY_MS) {
    const list = AddOnLogic.merge(segments), out = [];
    list.forEach((s, i) => {
      const prev = list[i - 1], next = list[i + 1];
      const len = ms(s.start, s.stop);
      if (len < maxMs) {
        out.push({
          kind: 'scrap', start: s.start, stop: s.stop, ms: len, take: s.take,
          before: prev && prev.stop === s.start ? prev.take : undefined,
          after: next && next.start === s.stop ? next.take : undefined,
          key: `scrap:${s.take}:${s.start}:${s.stop}`,
        });
      }
      if (next && next.start > s.stop) {
        const gap = ms(s.stop, next.start);
        if (gap < maxMs) out.push({ kind: 'gap', start: s.stop, stop: next.start, ms: gap, before: s.take, after: next.take, key: `gap:${s.stop}:${next.start}` });
      }
    });
    return out;
  },

  /**
   * The takes that could fill a tiny bit: those of the sections touching it, each with `ok`
   * false where that take has no audio across the bit. `extentOf(take)` is a take's audio span.
   * The user picks one (or, for a scrap, silence); the page does not choose for them.
   */
  tidyTakes(bit, extentOf) {
    const covers = (take) => { const e = extentOf(take); return !!e && e.start <= bit.start && e.stop >= bit.stop; };
    return [...new Set([bit.before, bit.after].filter(Boolean))].map((take) => ({ take, ok: covers(take) }));
  },

  /** Fill a tiny bit with take `use`, or make it silent (`use` null). */
  fillBit(segments, bit, use) {
    return use ? AddOnLogic.applySwipe(segments, use, bit.start, bit.stop) : AddOnLogic.clearRange(segments, bit.start, bit.stop);
  },

  /**
   * Apply the user's choices ([{ bit, use }]) left to right, so the result does not depend on
   * the order they were picked in.
   */
  tidy(segments, choices) {
    let list = AddOnLogic.merge(segments);
    for (const { bit, use } of [...choices].sort((a, b) => a.bit.start - b.bit.start)) list = AddOnLogic.fillBit(list, bit, use);
    return list;
  },

  // ── LUNA's grid ──────────────────────────────────────────────────────────────────────────

  /**
   * Ticks between grid lines for LUNA's Grid setting (`grid` such as "1_16", "1_4" or "bar";
   * `modifier` "normal", or a triplet or dotted one), in a bar of `barTicks`. Undefined when
   * the setting is not one it knows.
   */
  gridStep(grid, modifier, barTicks) {
    let step;
    if (grid === 'bar') step = barTicks;
    else {
      const m = /^1_(\d+)$/.exec(String(grid ?? ''));
      if (!m || !Number(m[1])) return undefined;
      step = Luna.WHOLE_NOTE / Number(m[1]);
    }
    if (/trip/i.test(String(modifier ?? ''))) step *= 2 / 3;
    else if (/dot/i.test(String(modifier ?? ''))) step *= 1.5;
    return step;
  },

  /** LUNA's Grid setting as it reads in its menu: "1/16", "1/8T", "1/4.", "Bar". */
  gridLabel(grid, modifier) {
    const base = grid === 'bar' ? 'Bar' : String(grid ?? '').replace('_', '/');
    return `${base}${/trip/i.test(String(modifier ?? '')) ? 'T' : /dot/i.test(String(modifier ?? '')) ? '.' : ''}`;
  },

  /** The grid line nearest `tick`, counting from the bar's start (barStart) to its end (barStop). */
  snapInBar(tick, barStart, barStop, step) {
    if (!(step > 0)) return Math.round(tick);
    const k = Math.round((tick - barStart) / step), t = Math.min(barStop, barStart + k * step);
    return Math.round(Math.abs(barStop - tick) < Math.abs(t - tick) ? barStop : t);
  },

  // ── LUNA's markers ──────────────────────────────────────────────────────────────────────
  // The page draws the session's markers on its ruler, in their LUNA colours (ARGB integers).

  /** An ARGB colour as CSS, with an alpha and an optional mix toward white (0 to 1). */
  argbCss(argb, alpha = 1, lighten = 0) {
    const v = (argb ?? 0) >>> 0, mix = (c) => Math.round(c + (255 - c) * lighten);
    return `rgba(${mix((v >>> 16) & 255)}, ${mix((v >>> 8) & 255)}, ${mix(v & 255)}, ${alpha})`;
  },
  /** Dark or white text, whichever reads on an ARGB background. */
  textOn(argb) {
    const v = (argb ?? 0) >>> 0;
    return 0.2126 * ((v >>> 16) & 255) + 0.7152 * ((v >>> 8) & 255) + 0.0722 * (v & 255) > 150 ? '#141414' : '#ffffff';
  },
  /**
   * Marker tags along the ruler. Each `{ x, want }` (its marker's position and the width its
   * name wants) gets a width `w`, cut short where the next marker starts or at `right`; one
   * squeezed to nothing keeps a sliver of colour. Returned in timeline order.
   */
  layoutTags(marks, right, gap = 2, min = 4) {
    const sorted = [...marks].sort((a, b) => a.x - b.x);
    return sorted.map((m, i) => ({ ...m, w: Math.max(min, Math.min(m.want, (sorted[i + 1]?.x ?? right) - m.x - gap)) }));
  },

  /** Keep a swipe inside the take's audio. Returns [a, b] sorted, or undefined if nothing is left. */
  clampToExtent(a, b, extent) {
    if (!extent) return undefined;
    const start = Math.max(Math.min(a, b), extent.start), stop = Math.min(Math.max(a, b), extent.stop);
    return stop > start ? [start, stop] : undefined;
  },

  /** The take chosen at `tick`, or undefined. */
  takeAt(segments, tick) {
    return segments.find((s) => s.start <= tick && tick < s.stop)?.take;
  },

  /** Drop segments whose take no longer exists. */
  prune(segments, takeIds) {
    const live = new Set(takeIds);
    return AddOnLogic.merge(segments.filter((s) => live.has(s.take)));
  },

  /** Snap a tick to the nearest multiple of `step` (no snapping when step is falsy). */
  snap(tick, step) {
    return step ? Math.round(tick / step) * step : Math.round(tick);
  },

  /**
   * What a playlist plays, worked out from its own clips the way LUNA does it (fact 116): cut at
   * every clip edge, each piece to the highest layer, then the narrower clip, then the larger
   * uid. LUNA 3.1.2 reports the same compiled clips under every playlist of a track, so they
   * cannot be trusted for a take that is not playing. Returns [{ clip, start, stop }].
   */
  compile(clips) {
    const cs = clips.filter((c) => c.start.value !== undefined && c.stop.value > c.start.value);
    const edges = [...new Set(cs.flatMap((c) => [c.start.value, c.stop.value]))].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i], b = edges[i + 1];
      const over = cs.filter((c) => c.start.value <= a && c.stop.value >= b);
      if (!over.length) continue;
      over.sort((x, y) =>
        (y.layer.value ?? 0) - (x.layer.value ?? 0) ||
        (x.stop.value - x.start.value) - (y.stop.value - y.start.value) ||
        (y.id > x.id ? 1 : y.id < x.id ? -1 : 0));
      const top = over[0], last = out[out.length - 1];
      if (last && last.clip === top && last.stop === a) last.stop = b;
      else out.push({ clip: top, start: a, stop: b });
    }
    return out;
  },

  /** A playlist's pieces, from its own clips. */
  piecesOf(playlist) {
    return AddOnLogic.compile(playlist.clips.items);
  },

  // ── reading the session ───────────────────────────────────────────────────────────────

  /** Every playlist on the track, in take order. */
  playlistsOf(session, track) {
    return session.playlists.items
      .filter((p) => p.trackUid.value === track.id)
      .sort((a, b) => (a.version.value ?? 0) - (b.version.value ?? 0));
  },

  /**
   * The track's comp playlist: the one whose id the page saved when it made it, else (say the
   * session was copied and ids changed) one named "SwipeComp". Undefined if it was deleted.
   */
  compLaneOf(session, track) {
    const lanes = AddOnLogic.playlistsOf(session, track);
    const stored = AddOnLogic.store(session).value(track.id, 'compLane').value;
    return lanes.find((p) => p.id === stored) ?? lanes.find((p) => p.name.value === AddOnLogic.COMP_NAME);
  },

  /** Post one of the session's own commands to LUNA. */
  sessionCommand(session, name, payload) {
    return session.client.raw.post(`${session.path}/${name}`, { session_uid: session.uid, ...payload });
  },

  /**
   * Make the playlist with this version the one LUNA plays on this track, and only this track.
   * (The SDK's setPlaylist passes LUNA's "main" edit context, which LUNA uses to switch every
   * track in an active edit group to the same version number, making that version on any track
   * that lacks it. The page comps one track at a time.)
   */
  showPlaylist(session, trackId, version) {
    return AddOnLogic.sessionCommand(session, 'set_playlists', { track_uid: [trackId], version });
  },

  /** Make a new empty playlist on this track only (see showPlaylist for why not newPlaylists). */
  addPlaylist(session, trackId) {
    return AddOnLogic.sessionCommand(session, 'new_playlists', { track_uid: [trackId], duplicate: false });
  },

  /** The playlists to swipe across: every one but the comp. */
  takesOf(session, track) {
    const comp = AddOnLogic.compLaneOf(session, track);
    return AddOnLogic.playlistsOf(session, track).filter((p) => p !== comp);
  },

  /**
   * Tracks that can be comped: every audio and instrument (MIDI) track, even one with a single
   * take (one long recording, comped by keeping the parts you want), and any other track with
   * several playlists. In the session's own order.
   */
  compableTracks(session) {
    return session.visibleTracks.filter((t) =>
      t.trackType.value === 'audio' || AddOnLogic.isMidiTrack(t) || AddOnLogic.playlistsOf(session, t).length > 1);
  },

  /** An instrument track: its takes are MIDI clips, comped by LUNA's own promote_takes, with no fades. */
  isMidiTrack(track) {
    return track?.trackType.value === 'instrument';
  },

  store(session) {
    return session.storage.context(AddOnLogic.STORE);
  },

  /** The saved comp list for a track ([] when none). */
  savedSegments(session, track) {
    const v = AddOnLogic.store(session).value(track.id, 'segments').value;
    return Array.isArray(v) ? v.filter((s) => s && typeof s.take === 'string') : [];
  },

  /** First and last tick with audio across the takes. */
  extent(takes) {
    let start = Infinity, stop = -Infinity;
    for (const p of takes) for (const piece of AddOnLogic.piecesOf(p)) {
      start = Math.min(start, piece.start);
      stop = Math.max(stop, piece.stop);
    }
    return Number.isFinite(start) ? { start, stop } : undefined;
  },

  /**
   * The clips the comp needs: for each segment, each piece of its take's audio inside it,
   * with the matching span of the recording in a straight line. That span is used only for a
   * plain take: a piece of a warped take (`warped`, by clip id) is copied by LUNA's promote_takes,
   * which keeps its warp markers and finds its own span. Given the take clips' markers (`markers`,
   * by clip id, from warpInfo), such a piece carries their fingerprint over its span (`sig`).
   */
  plan(session, segments, warped, markers) {
    const t = session.musical.timeline, pieces = [];
    for (const s of segments) {
      const take = session.playlists.byId(s.take);
      if (!take) continue;
      for (const piece of AddOnLogic.piecesOf(take)) {
        const a = Math.max(s.start, piece.start), b = Math.min(s.stop, piece.stop);
        if (!(b > a)) continue;
        const clip = piece.clip;
        if (clip.clipType.value === 'midi') {
          // A MIDI piece is copied by LUNA (promote_takes), so it needs no offsets into a file.
          pieces.push({ clip, take: s.take, name: take.name.value ?? clip.name.value, startTick: a, stopTick: b, midi: true });
          continue;
        }
        const at = (tick) => clip.sourceStart.value + (t.seconds(tick) - t.seconds(clip.start.value)) * 1e9;
        const isWarped = !!warped?.has(clip.id), list = isWarped && markers?.get(clip.id);
        pieces.push({
          clip, take: s.take, name: take.name.value ?? clip.name.value, warped: isWarped,
          startTick: a, stopTick: b, sourceStartNs: Math.round(at(a)), sourceStopNs: Math.round(at(b)),
          ...(list ? { sig: AddOnLogic.warpSig(list, a, b) } : {}),
        });
      }
    }
    return pieces;
  },

  /**
   * Audio files of these playlists that LUNA has not analysed yet, each with a lane using it: the
   * files the page draws from (see drawSource). Sources in `skip` (ids) are left out: those already
   * asked for once (see analyzeTakes).
   */
  async unanalyzed(session, lanes, skip = new Set()) {
    const seen = new Set(), out = [];
    for (const lane of lanes) {
      for (const clip of lane.clips.items) {
        const source = AddOnLogic.drawSource(session, clip);
        if (!source || seen.has(source.id) || skip.has(source.id)) continue;
        seen.add(source.id);
        if (!(await AddOnLogic.hasOverview(source))) out.push({ lane, source });
      }
    }
    return out;
  },

  // ── drawing warped clips ──────────────────────────────────────────────────────────────
  // A warped clip (LUNA plays a time-stretched rendering of it, `render_source_uid` set) is drawn
  // from its original recording, bent through its warp markers as LUNA plays it. LUNA never
  // analyses the rendering: measured on 96 warped clips in one session, every rendering had
  // no waveform and every original had one (quantized drums, edited horns, tuned vocals).

  /** Whether LUNA plays a rendering of this clip rather than its recording. */
  isRendered(clip) {
    return clip?.clipType.value !== 'midi' && !!clip?.renderSourceUid.value;
  },

  /** The file the page draws a clip's waveform from: its recording, even for a warped clip. */
  drawSource(session, clip) {
    if (!session.sources || clip.clipType.value === 'midi') return undefined;
    if (AddOnLogic.isRendered(clip)) return session.sources.byId(clip.sourceUid.value);
    return Luna.clipAudio(clip, session.sources)?.source;
  },

  warpCache: new Map(),
  /**
   * A clip's warp markers, `[{ tick, ns, moved }]` by tick: the file at `ns` (its `source_start`)
   * plays at `tick` (the clip's start plus the marker's `start`; markers count from the clip's own
   * start, measured 11/21 and 11/23); `moved` when the marker is no longer where it was set. Read
   * from LUNA once per clip and kept until the clip or its rendering changes (a new warp makes a
   * new rendering), or read afresh with `{ fresh: true }` (a comp change, which must know).
   */
  async warpMarkers(session, clip, { fresh = false } = {}) {
    const key = [clip.renderSourceUid.value, clip.start.value, clip.stop.value, clip.sourceStart.value].join('|');
    const hit = AddOnLogic.warpCache.get(clip.id);
    if (!fresh && hit?.key === key) return hit.list;
    let list = [];
    try {
      const node = await session.client.raw.get(`${clip.path}/warps`, { levels: 2 });
      list = (node?.children ?? []).map((w) => w.properties ?? {})
        .filter((p) => p.type?.value === 'warp' && Number.isFinite(p.start?.value) && Number.isFinite(p.source_start?.value))
        .map((p) => ({ tick: clip.start.value + p.start.value, ns: p.source_start.value, moved: p.start.value !== p.start_original?.value }))
        .sort((x, y) => x.tick - y.tick);
    } catch { list = []; }
    AddOnLogic.warpCache.set(clip.id, { key, list });
    return list;
  },

  /**
   * A short fingerprint of the warp markers that shape the stretch `a`-`b` of a clip (`markers`
   * from warpMarkers): those inside it and the nearest on each side. LUNA's promote_takes copies
   * every marker of the take into the comp clip at the same place (measured on a drum kit:
   * 724 of 724, within about 100 ticks), so a copy and its take agree until one is warped again.
   * Places are rounded (1e8 ticks is about 20 samples) so LUNA's few ticks of difference agree.
   */
  warpSig(markers, a, b) {
    const lo = a - AddOnLogic.SLACK, hi = b + AddOnLogic.SLACK;
    let from = markers.findIndex((m) => m.tick >= lo);
    from = from < 0 ? markers.length - 1 : Math.max(0, from - 1);
    let to = markers.findIndex((m) => m.tick > hi);
    if (to < 0) to = markers.length - 1;
    const text = markers.slice(Math.max(0, from), to + 1).map((m) => `${Math.round(m.tick / 1e8)}:${Math.round(m.ns / 1e4)}`).join(',');
    let h = 0x811c9dc5;   // FNV-1a
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${h.toString(36)}.${text ? text.split(',').length : 0}`;
  },

  /**
   * The warps a comp change depends on, read afresh from LUNA (before its transaction): the take
   * clips `segments` draw on that are warped (`warped`, ids; see isWarped for the rule) and their
   * markers (`markers`, by clip id).
   */
  async warpInfo(session, segments) {
    const warped = new Set(), markers = new Map();
    for (const id of new Set(segments.map((s) => s.take))) {
      for (const c of session.playlists.byId(id)?.clips.items ?? []) {
        if (c.clipType.value === 'midi') continue;
        const list = await AddOnLogic.warpMarkers(session, c, { fresh: true });
        if (c.renderSourceUid.value || list.some((m) => m.moved)) { warped.add(c.id); markers.set(c.id, list); }
      }
    }
    return { warped, markers };
  },

  /** Whether any take on the track is warped. Stops at the first. */
  async hasWarpedTakes(session, track) {
    for (const take of AddOnLogic.takesOf(session, track)) {
      await take.clips.load();
      for (const c of take.clips.items) if (c.clipType.value !== 'midi' && await AddOnLogic.isWarped(session, c)) return true;
    }
    return false;
  },

  /**
   * The file position (ns) a warped clip plays at each tick: between two markers the audio runs
   * evenly; before the first and after the last, at its own speed. With no markers (stretched
   * whole, as by a tempo change), evenly from the clip's start to its end. Times through the
   * session's tempo map.
   */
  warpedNsAt(timeline, clip, markers) {
    const sec = (tk) => timeline.seconds(tk);
    const pts = (markers?.length ? markers : [{ tick: clip.start.value, ns: clip.sourceStart.value }, { tick: clip.stop.value, ns: clip.sourceStop.value }])
      .map((m) => ({ s: sec(m.tick), ns: m.ns }));
    const own = !!markers?.length;   // markers: past them the audio runs at its own speed
    return (tick) => {
      const at = sec(tick);
      if (pts.length === 1 || at <= pts[0].s) return own || pts.length === 1 ? pts[0].ns + (at - pts[0].s) * 1e9 : pts[0].ns;
      const last = pts[pts.length - 1];
      if (at >= last.s) return own ? last.ns + (at - last.s) * 1e9 : last.ns;
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].s <= at) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[hi], span = b.s - a.s;
      return span > 0 ? a.ns + ((at - a.s) / span) * (b.ns - a.ns) : a.ns;
    };
  },

  /**
   * What to draw a clip's waveform from: `{ source, startNs, stopNs, nsAt(tick) }`, or undefined.
   * A plain clip, its recording in a straight line (the SDK's clipAudio); a warped clip, its
   * recording through its markers (`markers` from warpMarkers). Warped by the rule that building
   * uses (isWarped): a rendering, or a moved marker (LUNA can drop a warped clip's rendering and
   * keep its moved markers, seen 11/21; it renders it again to play it).
   */
  drawAudio(session, clip, markers) {
    const t = session.musical.timeline;
    if (AddOnLogic.isRendered(clip) || markers?.some((m) => m.moved)) {
      const source = session.sources?.byId(clip.sourceUid.value);
      if (!source) return undefined;
      return { source, startNs: clip.sourceStart.value, stopNs: clip.sourceStop.value, nsAt: AddOnLogic.warpedNsAt(t, clip, markers), warped: true };
    }
    const audio = session.sources && Luna.clipAudio(clip, session.sources);
    if (!audio) return undefined;
    return { source: audio.source, startNs: audio.startNs, stopNs: audio.stopNs, nsAt: (tick) => Luna.audioNsAtTick(t, clip, audio, tick) };
  },

  /** Whether LUNA has a waveform for this source (false when it cannot say). */
  async hasOverview(source) {
    try { return !!(await source.overviewInfo()); } catch { return false; }
  },

  /**
   * LUNA analyses a take's audio (for its waveform) once that take is the playlist it plays,
   * within about a third of a second in a small session, over a second in a big one (measured
   * on LUNA 3.1.2). Visit each take that needs it and come back, inside one continuous
   * transaction, so the visits leave one undo step that changes nothing rather than one per take.
   *
   * Nothing in the transaction may throw: LUNA 3.1.2 leaves a connection whose continuous
   * transaction was aborted in continuous mode, each later command replacing the one before it
   * (measured 11/23: after an abort, two playlist switches left one undo entry). That broke every
   * later comp change (the rename undid the new SwipeComp playlist). So each visit is guarded,
   * the tracks always go back to their playlists, and the transaction always commits.
   *
   * Some takes are never drawn however long they are shown (a warped take whose rendering LUNA
   * does not analyse, seen on quantized drums), so each take is waited for at most `waitMs`,
   * the whole pass stops after `budgetMs`, and `shouldStop()` (another track opened, or playback
   * starting) ends it at the next check. `onProgress(n, of, lane)` before each visit. Resolves to
   * `{ drawn, tried }`: sources now drawn, and every source asked for (not asked for again this visit).
   */
  async analyzeTakes(session, track, missing, { shouldStop = () => false, onProgress, waitMs = 3000, budgetMs = 90000 } = {}) {
    const drawn = [], tried = [];
    const trackOf = (lane) => session.tracks.byId(lane.trackUid.value) ?? track;
    // One visit per take, waiting for all of its files. A take its track is playing is on LUNA's
    // Timeline already: showing it again changes nothing (LUNA draws it if it can; a warped take it
    // never does). Such a switch is also no command to start a continuous transaction with: on
    // Floor Tom (playing V2, undrawn) the pass ended up taking back the user's last step (11/23). So
    // those are asked for once and never visited, and without a take to visit, or when asked to
    // stop already, there is no transaction at all.
    const visits = new Map();   // lane -> its sources with no waveform
    for (const m of missing) {
      if (session.playlistFor(trackOf(m.lane)) === m.lane) { tried.push(m.source); continue; }
      if (!visits.has(m.lane)) visits.set(m.lane, []);
      visits.get(m.lane).push(m.source);
    }
    if (!visits.size || shouldStop()) return { drawn, tried };
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const began = Date.now();
    const allDrawn = async (sources) => { for (const s of sources) if (!(await AddOnLogic.hasOverview(s))) return false; return true; };
    // Each lane is visited on its own track (a grouped track's takes too); every track touched
    // goes back to the playlist it was playing.
    const originals = new Map();
    await session.transaction('Draw take waveforms', async () => {
      for (const [k, [lane, sources]] of [...visits].entries()) {
        if (k > 0 && (shouldStop() || Date.now() - began > budgetMs)) break;   // the first visit always happens
        tried.push(...sources);
        try { onProgress?.(k + 1, visits.size, lane); } catch { /* drawing the progress is not the pass */ }
        try {
          const tid = lane.trackUid.value ?? track.id;
          if (!originals.has(tid)) originals.set(tid, session.playlistFor(session.tracks.byId(tid) ?? track));
          if (!(await allDrawn(sources))) {
            await AddOnLogic.showPlaylist(session, tid, lane.version.value);
            const until = Date.now() + waitMs;
            while (Date.now() < until && !shouldStop() && !(await allDrawn(sources))) await pause(100);
          }
          for (const s of sources) if (await AddOnLogic.hasOverview(s)) drawn.push(s);
        } catch { /* on to the next take: the transaction must still commit */ }
      }
      for (const [tid, original] of originals) {
        const t = session.tracks.byId(tid);
        if (!original || (t && session.playlistFor(t) === original)) continue;   // already back: no empty switch
        try { await AddOnLogic.showPlaylist(session, tid, original.version.value); } catch { /* see below */ }
      }
    }, { continuous: true });
    // Should a switch back have failed, put the track back now (a step of its own, outside the pass).
    for (const [tid, original] of originals) {
      const t = session.tracks.byId(tid);
      if (t && original && session.playlistFor(t) !== original) {
        try { await AddOnLogic.showPlaylist(session, tid, original.version.value); } catch { /* left as it is */ }
      }
    }
    return { drawn, tried };
  },

  /**
   * The take a comp clip came from: as recorded when the page placed it (kept in the same undo
   * step as the clips, so it agrees with them after an undo), else the comp section it sits in.
   */
  takeOfClip(session, lane, segments, clip) {
    const placed = lane && AddOnLogic.store(session).value(lane.trackUid.value, 'placed').value;
    const rec = Array.isArray(placed) ? placed.find((p) => p.id === clip.id) : undefined;
    return rec?.take ?? AddOnLogic.takeAt(segments, clip.start.value);
  },

  /** Comp clips whose name is not their take's name, with the name each should have. */
  misnamedCompClips(session, lane, segments) {
    const out = [];
    const byLuna = lane ? new Set(AddOnLogic.madeByLuna(session, session.tracks.byId(lane.trackUid.value), lane)) : new Set();
    for (const clip of lane?.clips.items ?? []) {
      if (clip.clipType.value === 'midi' || byLuna.has(clip)) continue;   // LUNA names what it promotes; left as it is
      const take = AddOnLogic.takeOfClip(session, lane, segments, clip);
      const name = take && session.playlists.byId(take)?.name.value;
      if (name && clip.name.value !== name) out.push({ clip, name });
    }
    return out;
  },

  /** Give comp clips their takes' names (for a comp built before clips were named). One undo step. */
  async nameCompClips(session, lane, segments) {
    const wrong = AddOnLogic.misnamedCompClips(session, lane, segments);
    if (!wrong.length) return 0;
    await session.transaction('Name comp clips', async () => {
      for (const { clip, name } of wrong) await clip.name.set(name);
    });
    return wrong.length;
  },

  /**
   * Rename a take (its playlist, so LUNA's playlist menu shows the name too) and every comp
   * clip that came from it, as one undo step. The playlist is renamed with LUNA's own rename
   * command (on this track only), the one its playlist menu uses, so an undo puts the take's
   * name back along with its clips' names.
   */
  async renameTake(session, take, newName, lane, segments) {
    const name = String(newName ?? '').trim();
    if (!name || name === take.name.value) return false;
    await session.transaction('Rename take', async () => {
      await AddOnLogic.sessionCommand(session, 'set_playlist_name', { track_uid: take.trackUid.value, version: take.version.value, name });
      for (const clip of lane?.clips.items ?? []) {
        if (AddOnLogic.takeOfClip(session, lane, segments, clip) === take.id && clip.name.value !== name) await clip.name.set(name);
      }
    });
    return true;
  },

  /**
   * Play or stop. Starting, play from the playhead if it is inside the ticks on screen,
   * otherwise from the left edge of the screen, so playback starts where you are looking.
   */
  async playOrStop(session, viewStart, viewEnd) {
    const t = session.transport;
    if (t.playing.value) { await t.stop(); return false; }
    const at = t.tick;
    if (!(at >= viewStart && at <= viewEnd)) await t.seek(Math.max(0, Math.round(viewStart)));
    await t.play();
    return true;
  },

  // ── changing the session ──────────────────────────────────────────────────────────────

  /**
   * Create the track's storage fields once, outside the undo history. Later writes of the comp
   * list are undoable `set`s: an undo then restores the old list and LUNA pushes the change.
   * (An undone `add` removes the field, which LUNA does not push to anyone.)
   */
  async ensureFields(session, track) {
    const store = AddOnLogic.store(session);
    if (store.value(track.id, 'segments').value === undefined) await store.add(track.id, 'segments', [], { undoable: false });
    if (store.value(track.id, 'placed').value === undefined) await store.add(track.id, 'placed', null, { undoable: false });
  },

  /**
   * Clips on the comp playlist the page did not put there, or that were moved or trimmed since:
   * a recording, or an edit made in LUNA. The page records each clip it places (id, start,
   * stop) with the comp; a comp from before it kept that record has none, and nothing counts.
   */
  foreignClips(session, lane, track) {
    const placed = AddOnLogic.store(session).value(track.id, 'placed').value;
    if (!Array.isArray(placed)) return [];
    const ours = new Map(placed.filter((p) => p.id).map((p) => [p.id, p]));
    const bySpan = placed.filter((p) => !p.id);   // MIDI comp clips: LUNA makes them, so no id is known
    const near = (p, c) => Math.abs(p.start - c.start.value) <= AddOnLogic.SLACK && Math.abs(p.stop - c.stop.value) <= AddOnLogic.SLACK;
    return (lane?.clips.items ?? []).filter((c) => {
      const p = ours.get(c.id);
      if (p) return !near(p, c);
      return !bySpan.some((q) => near(q, c));
    });
  },

  /**
   * Whether LUNA has warped this clip: a warp marker under the clip's `warps` moved from where it
   * was set (`start` no longer its `start_original`), or a rendering LUNA made of it. Measured on
   * LUNA 3.1.2: a warp adds markers and a `render_source_uid`, but the rendering can later be
   * dropped while the markers stay, and the clip's span and place in the recording never change,
   * so the span check in foreignClips cannot see a warp. Reads LUNA.
   */
  async isWarped(session, clip) {
    if (clip?.renderSourceUid?.value) return true;
    try {
      const node = await session.client.raw.get(`${clip.path}/warps`, { levels: 2 });   // warps, marker, its properties
      return (node?.children ?? []).some((w) => {
        const p = w.properties ?? {};
        return p.type?.value === 'warp' && p.start?.value !== p.start_original?.value;
      });
    } catch {
      return false;
    }
  },

  /**
   * The ids of the take clips `segments` draw on that are warped in LUNA. Their sections are
   * copied by LUNA's promote_takes: LUNA's insert_clip copy of a warped clip at a new start puts
   * its warp markers in the wrong place (it takes the new clip's start off each marker without
   * adding the old one's; measured on LUNA 3.1.2), while promote_takes keeps them where they were.
   */
  async warpedTakeClips(session, segments) {
    return (await AddOnLogic.warpInfo(session, segments)).warped;
  },

  /**
   * The comp's clips that Swipe Comping had LUNA make from a warped take (recorded `byLuna`, or
   * with no id by an earlier version), by id or else by span: a Map of clip to its record.
   */
  lunaRecords(session, track, lane) {
    const placed = AddOnLogic.store(session).value(track.id, 'placed').value;
    const recs = Array.isArray(placed) ? placed.filter((r) => r.byLuna || !r.id) : [];
    const near = (r, c) => Math.abs(r.start - c.start.value) <= AddOnLogic.SLACK && Math.abs(r.stop - c.stop.value) <= AddOnLogic.SLACK;
    const out = new Map();
    for (const c of lane?.clips.items ?? []) {
      const r = recs.find((x) => (x.id ? x.id === c.id : near(x, c)));
      if (r) out.set(c, r);
    }
    return out;
  },

  /** The comp's clips that Swipe Comping had LUNA make from a warped take (see lunaRecords). */
  madeByLuna(session, track, lane) {
    return [...AddOnLogic.lunaRecords(session, track, lane).keys()];
  },

  /**
   * For comp clips LUNA made from a warped take whose record has no fingerprint (recorded before
   * 11/23 afternoon): the fingerprint of the warps they play now, by clip id, taken to be as they
   * were copied. Reads LUNA (about 5 ms a clip).
   */
  async legacySigs(session, track, lane) {
    const out = new Map();
    for (const [c, r] of AddOnLogic.lunaRecords(session, track, lane)) {
      if (r.sig !== undefined || AddOnLogic.isMidiTrack(track)) continue;
      out.set(c.id, AddOnLogic.warpSig(await AddOnLogic.warpMarkers(session, c, { fresh: true }), r.start, r.stop));
    }
    return out;
  },

  /**
   * What a comp change on this track needs to know about warps, read before its transaction:
   * warpInfo for `segments`, and legacySigs. Pass it on as options to clipsReplaced or writeComp.
   */
  async warpState(session, track, lane, segments) {
    const { warped, markers } = await AddOnLogic.warpInfo(session, segments);
    return { warped, markers, legacy: await AddOnLogic.legacySigs(session, track, lane), left: AddOnLogic.warpsLeft(session, track) };
  },

  /**
   * Sections of the comp behind their take: the take was warped again (or first warped, or
   * unwarped) after the section was copied, so the comp still plays the warps it was copied with.
   * They stay so until a swipe covers them, or the user asks for them all (a
   * swipe changes only the places it covers, and the page asks). `left` when the user chose to
   * leave that section as it is (see warpsLeft). `[{ take, name, startTick, stopTick, key, left }]`.
   */
  async staleSections(session, track, lane, segments) {
    const placed = AddOnLogic.store(session).value(track.id, 'placed').value;
    if (!lane || !Array.isArray(placed) || AddOnLogic.isMidiTrack(track)) return [];
    const list = AddOnLogic.merge(segments);
    await AddOnLogic.loadTakes(session, list);
    const { warped, markers, legacy, left } = await AddOnLogic.warpState(session, track, lane, list);
    const pieces = AddOnLogic.plan(session, list, warped, markers), stale = [];
    AddOnLogic.reusableClips(lane, placed, pieces, { legacy, stale });
    return stale.map((i) => pieces[i]).map((p) => {
      const key = AddOnLogic.leftKey(p);
      return { take: p.take, name: p.name, startTick: p.startTick, stopTick: p.stopTick, key, left: left.has(key) };
    });
  },

  /** A section behind its take, as the user left it: its take, place, and the take's warps then. */
  leftKey(p) {
    return `${p.take}|${p.startTick}|${p.stopTick}|${p.sig ?? '-'}`;
  },

  /**
   * Sections behind their take that the user chose to leave as they are (keys from leftKey): not
   * mentioned again until the take's warps change again. "Update them all" passes them by too;
   * a swipe over one copies it afresh.
   */
  warpsLeft(session, track) {
    const v = AddOnLogic.store(session).value(track.id, 'warpsLeft').value;
    return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
  },

  /** Remember which sections behind their take to leave as they are. Not an undo step. */
  async setWarpsLeft(session, track, keys) {
    const store = AddOnLogic.store(session), list = [...keys].sort();
    if (store.value(track.id, 'warpsLeft').value === undefined) await store.add(track.id, 'warpsLeft', list, { undoable: false });
    else await store.set(track.id, 'warpsLeft', list, { undoable: false });
  },

  /** Whether a change refreshes this section behind its take: `refresh` true (all but those left), or ranges `[[a, b]]` it overlaps. */
  refreshes(p, refresh, left) {
    if (refresh === true) return !left?.has(AddOnLogic.leftKey(p));
    return (refresh ?? []).some(([a, b]) => a < p.stopTick && b > p.startTick);
  },

  /** A per-track yes/no the user has given (see setFlag). */
  flag(session, track, key) {
    return AddOnLogic.store(session).value(track.id, key).value === true;
  },

  /**
   * Remember a per-track answer: `warpAck`, the warp heads-up read and accepted; `compWarpsOk`,
   * swipes may replace warps made on the comp without asking. Not an undo step.
   */
  async setFlag(session, track, key, on = true) {
    const store = AddOnLogic.store(session);
    if (store.value(track.id, key).value === undefined) await store.add(track.id, key, !!on, { undoable: false });
    else if (store.value(track.id, key).value !== !!on) await store.set(track.id, key, !!on, { undoable: false });
  },

  /**
   * The uid of the clip LUNA has just made on `lane` over `start`-`stop` (promote_takes answers
   * nothing), not one of `known`. LUNA shows it at once, inside the change, so the change can
   * name and crossfade it in the same undo step (measured on LUNA 3.1.2).
   */
  async clipMadeAt(session, lane, start, stop, known) {
    const node = await session.client.raw.get(`${lane.path}/clips`, { levels: 2 });
    const hit = (node?.children ?? []).map((c) => c.properties ?? {})
      .find((p) => p.uid?.value && !known.has(p.uid.value) && Math.abs(p.start?.value - start) <= AddOnLogic.SLACK && Math.abs(p.stop?.value - stop) <= AddOnLogic.SLACK);
    return hit?.uid.value;
  },

  /**
   * Comp clips a change to `segments` would replace: those the rewrite does not keep. A rewrite
   * that starts over (no record of the clips, or a new crossfade length) replaces them all, and
   * so does every MIDI change (a MIDI comp is rewritten whole).
   */
  clipsReplaced(session, track, lane, segments, { fadeMs = 10, warped, markers, legacy, left, refresh } = {}) {
    const all = lane?.clips.items ?? [];
    if (!all.length || AddOnLogic.isMidiTrack(track)) return [...all];
    const placed = AddOnLogic.store(session).value(track.id, 'placed').value;
    const lastFade = AddOnLogic.savedFadeMs(session, track);
    if (!Array.isArray(placed) || (lastFade !== undefined && lastFade !== fadeMs)) return [...all];
    const kept = new Set(AddOnLogic.reusableClips(lane, placed, AddOnLogic.plan(session, AddOnLogic.merge(segments), warped, markers), { legacy, left, refresh }).values());
    return all.filter((c) => !kept.has(c));
  },

  /**
   * Of the comp clips a change would replace, those warped on the comp itself in LUNA (their
   * warps would be lost): a clip the page copied straight that LUNA has since warped, or one
   * LUNA copied from a warped take whose warps no longer match the fingerprint taken as it was
   * copied. Not a copy that still plays its take's warps: those come back with the take.
   */
  async warpedClipsReplaced(session, track, lane, segments, options = {}) {
    const state = await AddOnLogic.warpState(session, track, lane, segments);
    const ours = AddOnLogic.lunaRecords(session, track, lane);
    const out = [];
    for (const c of AddOnLogic.clipsReplaced(session, track, lane, segments, { ...options, ...state })) {
      const rec = ours.get(c);
      if (rec) {
        const was = rec.sig ?? state.legacy.get(c.id);
        if (was !== undefined && AddOnLogic.warpSig(await AddOnLogic.warpMarkers(session, c, { fresh: true }), rec.start, rec.stop) !== was) out.push(c);
      } else if (await AddOnLogic.isWarped(session, c)) out.push(c);
    }
    return out;
  },

  /** Whether a playlist on the track is newer (higher take number) than the comp. */
  compBelowNewer(session, track, lane) {
    if (!lane) return false;
    return AddOnLogic.playlistsOf(session, track).some((p) => p !== lane && (p.version.value ?? 0) > (lane.version.value ?? 0));
  },

  /**
   * LUNA lists a track's playlists by take number, newest at the top (seen on LUNA 3.1.2), and
   * the number is writable. Give the comp the highest number and move each newer playlist down
   * one, so SwipeComp stays at the top of LUNA's list as takes are added. Names are untouched;
   * the "V" number LUNA shows beside a moved take drops by one. Call inside a transaction.
   */
  async raiseComp(session, track, lane) {
    const own = lane.version.value;
    const newer = AddOnLogic.playlistsOf(session, track)
      .filter((p) => p !== lane && p.version.value > own)
      .sort((a, b) => a.version.value - b.version.value);
    if (!newer.length) return false;
    const top = newer[newer.length - 1].version.value;
    await lane.property('version').set(99999);   // out of the way, so no two ever share a number
    for (const p of newer) await p.property('version').set(p.version.value - 1);
    await lane.property('version').set(top);
    return true;
  },

  /**
   * Whether comp changes keep SwipeComp at the top of LUNA's list (the default). False once the
   * user chose "Leave it here" for this track, say to hear a new take against the comp.
   */
  keepsOnTop(session, track) {
    return AddOnLogic.store(session).value(track.id, 'onTop').value !== false;
  },

  /**
   * The names of the steps LUNA's Undo and Redo would take: `entries` is LUNA's undo list
   * (`{rowid, uid, name}`, the first being "origin"), `currentUid` the session's `undo_uid` (the
   * step Undo takes back). Redo is taken to be the entry after it. '' when there is none.
   */
  undoSteps(entries, currentUid, { canUndo = true, canRedo = true } = {}) {
    const list = entries.filter((e) => e && e.uid).sort((a, b) => a.rowid - b.rowid);
    const i = list.findIndex((e) => e.uid === currentUid);
    return {
      undo: canUndo && i > 0 ? list[i].name ?? '' : '',
      redo: canRedo && i >= 0 && i + 1 < list.length ? list[i + 1].name ?? '' : '',
    };
  },

  /** The crossfade length (ms) last used on this track's comp, or undefined. */
  savedFadeMs(session, track) {
    const v = AddOnLogic.store(session).value(track.id, 'fadeMs').value;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  },

  /**
   * Remember the track's crossfade length, so a later visit rebuilds its seams at the same
   * length rather than the default. Not an undo step.
   */
  async setFadeMs(session, track, ms) {
    const store = AddOnLogic.store(session);
    if (store.value(track.id, 'fadeMs').value === undefined) await store.add(track.id, 'fadeMs', ms, { undoable: false });
    else if (store.value(track.id, 'fadeMs').value !== ms) await store.set(track.id, 'fadeMs', ms, { undoable: false });
  },

  /** Keys of the tiny bits (see tinyBits) the user chose to leave alone on this track. */
  leftAlone(session, track) {
    const v = AddOnLogic.store(session).value(track.id, 'leftAlone').value;
    return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
  },

  /** Remember which tiny bits to leave alone on this track. Not an undo step. */
  async setLeftAlone(session, track, keys) {
    const store = AddOnLogic.store(session), list = [...keys].sort();
    if (store.value(track.id, 'leftAlone').value === undefined) await store.add(track.id, 'leftAlone', list, { undoable: false });
    else await store.set(track.id, 'leftAlone', list, { undoable: false });
  },

  /** Remember whether comp changes keep SwipeComp on top for this track. Not an undo step. */
  async setKeepOnTop(session, track, on) {
    const store = AddOnLogic.store(session);
    if (store.value(track.id, 'onTop').value === undefined) await store.add(track.id, 'onTop', !!on, { undoable: false });
    else await store.set(track.id, 'onTop', !!on, { undoable: false });
  },

  /**
   * Move the comp to the top of LUNA's playlist list now, and keep it there from then on (this
   * undoes "Leave it here"). One undo step, which also brings back "Leave it here".
   */
  async keepCompOnTop(session, track, lane) {
    const store = AddOnLogic.store(session);
    const wasLeft = !AddOnLogic.keepsOnTop(session, track);
    if (!AddOnLogic.compBelowNewer(session, track, lane)) {
      if (wasLeft) await AddOnLogic.setKeepOnTop(session, track, true);
      return false;
    }
    await session.transaction('Move SwipeComp to the top', async () => {
      await AddOnLogic.raiseComp(session, track, lane);
      if (wasLeft) await store.set(track.id, 'onTop', true, { undoable: true });
    });
    return true;
  },

  /** Forget the saved comp list without touching any playlist (Clear comp when there is none). One undo step. */
  async clearSaved(session, track) {
    await AddOnLogic.ensureFields(session, track);
    await AddOnLogic.store(session).set(track.id, 'segments', [], { undoable: true });
  },

  /** Make (once) the track's empty "SwipeComp" playlist. Resolves to it. */
  async ensureCompLane(session, track) {
    await AddOnLogic.ensureFields(session, track);
    const existing = AddOnLogic.compLaneOf(session, track);
    if (existing) return existing;
    const before = new Set(AddOnLogic.playlistsOf(session, track).map((p) => p.id));
    await AddOnLogic.addPlaylist(session, track.id);
    let lane;
    for (let i = 0; i < 50 && !lane; i++) {
      await session.playlists.membersReady();   // a new playlist is listed before its fields are read
      lane = AddOnLogic.playlistsOf(session, track).find((p) => !before.has(p.id));
      if (!lane) await new Promise((r) => setTimeout(r, 40));
    }
    if (!lane) throw new Error('LUNA did not make the SwipeComp playlist');
    try { await lane.property('name').set(AddOnLogic.COMP_NAME); } catch { /* the name is cosmetic */ }
    const store = AddOnLogic.store(session);
    if (store.value(track.id, 'compLane').value === undefined) await store.add(track.id, 'compLane', lane.id, { undoable: false });
    else await store.set(track.id, 'compLane', lane.id, { undoable: false });
    return lane;
  },

  /** Post one of the edit context's commands (LUNA keeps the fade commands there, fact 117). */
  contextCommand(session, name, payload) {
    return session.client.raw.post(`${session.path}/contexts/main/commands/${name}`, { session_uid: session.uid, ...payload });
  },

  /** `ms` milliseconds after `tick`, in ticks (at least 1). */
  fadeTicks(session, tick, ms) {
    const t = session.musical.timeline;
    return Math.max(1, Math.round(t.tickAtSeconds(t.seconds(tick) + ms / 1000) - tick));
  },

  /**
   * The comp clips that can stay as they are for the new pieces: placed by the page, not moved
   * or trimmed since, from the same take, at the same place, playing the same part of the
   * recording. Map of piece index to clip. Kept clips keep whatever was done to them in LUNA
   * (clip gain, a crossfade edited in the Timeline, a warp made on the comp).
   *
   * A piece is behind its take when the take's warps over it are no longer what it was copied
   * with (its `sig` against the record's, or for a record without one, against `legacy`, what the
   * comp clip plays now), or the take has been warped or unwarped since. A piece behind is kept as
   * it is, old warps and all, unless `refresh` covers it (see refreshes): a swipe changes only the
   * places it covers. Indexes of pieces behind go in `stale`; the record each
   * kept piece was matched with, in `recs` (index to record).
   */
  reusableClips(lane, placed, pieces, { legacy, stale, refresh, left, recs } = {}) {
    const keep = new Map(), usedRec = new Set(), usedClip = new Set();
    if (!Array.isArray(placed)) return keep;
    const items = lane?.clips.items ?? [];
    const clips = new Map(items.map((c) => [c.id, c]));
    const near = (a0, a1, b0, b1) => Math.abs(a0 - b0) <= AddOnLogic.SLACK && Math.abs(a1 - b1) <= AddOnLogic.SLACK;
    for (const [i, p] of pieces.entries()) {
      const rec = placed.find((r) => !usedRec.has(r) && r.take === p.take && near(r.start, r.stop, p.startTick, p.stopTick));
      if (!rec) continue;
      // A record without an id is a clip LUNA made (promote_takes): found by its span.
      const c = rec.id ? clips.get(rec.id) : items.find((x) => !usedClip.has(x) && near(x.start.value, x.stop.value, rec.start, rec.stop));
      if (!c || usedClip.has(c)) continue;
      if (!near(c.start.value, c.stop.value, rec.start, rec.stop)) continue;
      // Behind its take: a piece of a warped take that LUNA did not copy (a straight copy from
      // before the take was warped) or whose take's warps differ from those it was copied with;
      // a piece of a plain take that LUNA copied (from when the take was warped). Kept unless
      // refreshed. Any other plain piece is kept only while it starts where it should.
      const byLuna = rec.byLuna || !rec.id;
      const was = rec.sig ?? legacy?.get(c.id);
      const behind = p.warped ? (!byLuna || (p.sig !== undefined && was !== undefined && was !== p.sig)) : byLuna;
      if (behind) {
        stale?.push(i);
        if (AddOnLogic.refreshes(p, refresh, left)) continue;
      } else if (!p.warped && !(Math.abs(c.sourceStart.value - p.sourceStartNs) <= 2000)) continue;
      keep.set(i, c);
      recs?.set(i, rec);
      usedRec.add(rec);
      usedClip.add(c);
    }
    return keep;
  },

  /**
   * The fades a comp change needs, and no others: the edges of new clips, and the edges of kept
   * clips whose neighbour there has changed. Every other edge keeps the fade it has (perhaps
   * one edited in LUNA). `ids[i]` is piece i's clip, `fresh[i]` whether it is new, and
   * `before` the neighbours each kept clip had (`{ left, right }` clip ids, null for none).
   * Each op is `{ kind: 'in' | 'out', clip, at }` or `{ kind: 'cross', left, right, at }`.
   */
  fadeEdits(pieces, ids, fresh, before) {
    const ops = [];
    const butted = (i) => i + 1 < pieces.length && Math.abs(pieces[i].stopTick - pieces[i + 1].startTick) <= 1;   // the page's own edges: exact
    const leftNow = (i) => (i > 0 && butted(i - 1) ? ids[i - 1] : null);
    const rightNow = (i) => (butted(i) ? ids[i + 1] : null);
    const dirty = (i, side) => fresh[i] || !before.has(ids[i]) || before.get(ids[i])[side] !== (side === 'left' ? leftNow(i) : rightNow(i));
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!(i > 0 && butted(i - 1)) && dirty(i, 'left')) ops.push({ kind: 'in', clip: ids[i], at: p.startTick, i });
      if (butted(i)) {
        if (dirty(i, 'right') || dirty(i + 1, 'left')) ops.push({ kind: 'cross', left: ids[i], right: ids[i + 1], at: p.stopTick, i });
      } else if (dirty(i, 'right')) ops.push({ kind: 'out', clip: ids[i], at: p.stopTick, i });
    }
    return ops;
  },

  /**
   * LUNA `set_fade` entries for `ops` (fact 117), `fadeMs` long but never longer than half the
   * piece (or pieces) a fade lies on, so a sliver of a few milliseconds still fades both ends.
   * `reach` is how far from the edit each fade extends, in ticks.
   */
  fadeEntries(session, playlistUid, pieces, ops, fadeMs) {
    const len = (i) => pieces[i].stopTick - pieces[i].startTick;
    return ops.map((op) => {
      const L = AddOnLogic.fadeTicks(session, op.at, fadeMs);
      if (op.kind === 'in' || op.kind === 'out') {
        const n = Math.max(1, Math.min(L, Math.floor(len(op.i) / 2)));
        const fade = op.kind === 'in'
          ? { playlist_uid: playlistUid, clip_uid: op.clip, fade_type: 'fade_in', start: op.at, stop_offset: n, fade_reference_edge: 'none' }
          : { playlist_uid: playlistUid, clip_uid: op.clip, fade_type: 'fade_out', stop: op.at, start_offset: -n, fade_reference_edge: 'none' };
        return { op, fade, reach: n };
      }
      const half = Math.max(1, Math.min(Math.round(L / 2), Math.floor(len(op.i) / 2), Math.floor(len(op.i + 1) / 2)));
      const fade = { playlist_uid: playlistUid, clip_uid: op.left, contributor_clip_uid: op.right, fade_type: 'cross_fade', start_offset: -half, stop_offset: half, fade_reference_edge: 'none' };
      return { op, fade, reach: half };
    });
  },

  /** Each placed clip's neighbours on the comp, from the page's record: id -> { left, right }. */
  neighboursOf(placed) {
    const out = new Map();
    if (!Array.isArray(placed)) return out;
    for (const r of placed) {
      out.set(r.id, {
        left: placed.find((o) => o !== r && Math.abs(o.stop - r.start) <= 1)?.id ?? null,   // records hold the page's own edges: exact
        right: placed.find((o) => o !== r && Math.abs(o.start - r.stop) <= 1)?.id ?? null,
      });
    }
    return out;
  },

  // ── edit groups ───────────────────────────────────────────────────────────────────────

  /**
   * The other tracks an edit on `track` reaches through LUNA's edit groups that are switched on
   * now: LUNA's own answer (`group_affected_tracks`, which reads the groups selected in the edit
   * context). [] when none, or when LUNA cannot say.
   */
  async groupMates(session, track) {
    try {
      const r = await AddOnLogic.sessionCommand(session, 'group_affected_tracks', { track_uid: track.id, group_attributes: 'edit', context_type: 'main' });
      const ids = Array.isArray(r?.tracks) ? r.tracks : [];
      return ids.filter((id) => id !== track.id).map((id) => session.tracks.byId(id)).filter(Boolean);
    } catch {
      return [];
    }
  },

  /**
   * Every LUNA group `track` is in, switched on or not, from LUNA's group list:
   * `[{ uid, name, on, edit, mix, trackIds }]`. `on`: switched on (in the edit context's group
   * selection); `edit`, `mix`: Edit, Mix among its attributes (Mix links solo, among the rest);
   * `trackIds`: its other members. [] when LUNA cannot say.
   */
  async groupsOf(session, track) {
    try {
      const raw = session.client.raw, at = session.path;
      const sel = JSON.parse((await raw.get(`${at}/contexts/main/selection_groups`))?.value ?? '[]');
      const groups = await raw.get(`${at}/groups`, { levels: 4 });   // group, members, member, its properties
      return AddOnLogic.readGroups(groups, sel, track.id);
    } catch {
      return [];
    }
  },

  /** groupsOf's reading of LUNA's `/groups` node (`levels: 4`) and group selection, for one track. */
  readGroups(node, selection, trackId) {
    const out = [];
    for (const g of node?.children ?? []) {
      const ids = (g.children?.find((c) => c.path === 'members')?.children ?? [])
        .map((m) => m.properties?.track_uid?.value).filter(Boolean);
      if (!ids.includes(trackId)) continue;
      const uid = g.properties?.uid?.value;
      const attrs = String(g.properties?.group_attributes?.value ?? '').split(',').map((a) => a.trim());
      out.push({
        uid,
        name: g.properties?.name?.value ?? 'group',
        on: Array.isArray(selection) && selection.includes(uid),
        edit: attrs.includes('edit'),
        mix: attrs.includes('mix'),
        trackIds: ids.filter((id) => id !== trackId),
      });
    }
    return out;
  },

  /**
   * How a track's groups comp:
   * - `'edit'`: LUNA links edits across the group (switched on, Edit ticked), so its tracks comp
   *   only together, never one alone. `lunaIds` is LUNA's own answer (groupMates), used first.
   * - `'ask'`: the track is only in groups that don't link edits (switched off, or no Edit): the
   *   user chooses between comping the group together and this track alone.
   * - `'none'`: in no group with other tracks.
   * `{ mode, trackIds, names }`: the tracks that would comp with it, and the groups' names.
   */
  groupPlan(groups, lunaIds = []) {
    const linked = groups.filter((g) => g.on && g.edit);
    if (lunaIds.length || linked.length) {
      const ids = lunaIds.length ? lunaIds : [...new Set(linked.flatMap((g) => g.trackIds))];
      return { mode: 'edit', trackIds: ids, names: linked.map((g) => g.name) };
    }
    const ids = [...new Set(groups.flatMap((g) => g.trackIds))];
    return ids.length ? { mode: 'ask', trackIds: ids, names: groups.filter((g) => g.trackIds.length).map((g) => g.name) } : { mode: 'none', trackIds: [], names: [] };
  },

  /**
   * Whether LUNA links this grouped track's solo to the track being comped: a group they share is
   * switched on with Mix among its attributes. Then soloing one solos both, in LUNA's own way.
   */
  soloLinked(groups, otherId) {
    return groups.some((g) => g.on && g.mix && g.trackIds.includes(otherId));
  },

  /** A take's first clip (by start), or undefined for an empty take. */
  firstClip(take) {
    let first;
    for (const c of take.clips.items) if (!first || c.start.value < first.start.value) first = c;
    return first;
  },

  /** The takes with something on them, oldest first (an empty New Version is not a take). */
  recordedTakes(session, track) {
    return AddOnLogic.takesOf(session, track).filter((p) => AddOnLogic.firstClip(p));
  },

  /**
   * Whether a group's tracks can comp together, by Logic's rule: every track has the same number
   * of recorded takes (an empty take is not counted). `{ lead, counts: [{ track, count }], same }`,
   * `lead` being `lead`'s own count. When `same` is false the page comps no grouped track, not
   * even the ones whose counts agree: comping some of a drum kit's mics and not others would
   * pull the kit apart. In an edit group the page then comps nothing at all and says how to fix
   * it; otherwise this track comps alone.
   */
  groupTakeCheck(session, lead, others) {
    const n = AddOnLogic.recordedTakes(session, lead).length;
    const counts = others.map((track) => ({ track, count: AddOnLogic.recordedTakes(session, track).length }));
    return { lead: n, counts, same: counts.every((c) => c.count === n) };
  },

  /**
   * Which take on `other` goes with each of `lead`'s takes (lead take id -> other take id), by
   * Logic's rule for comping grouped tracks: they comp together only when they have the same
   * number of takes, and then take 1 goes with take 1, take 2 with take 2, and so on, since takes
   * recorded together on grouped tracks line up that way. Empty takes are not counted. Tracks
   * whose counts differ get an empty map (groupTakeCheck stops the group comp first).
   */
  matchTakes(session, lead, other) {
    const a = AddOnLogic.recordedTakes(session, lead), b = AddOnLogic.recordedTakes(session, other);
    return a.length === b.length ? new Map(a.map((take, i) => [take.id, b[i].id])) : new Map();
  },

  /** `segments` in another track's takes, through `map`; sections with no matching take drop out. */
  mapSegments(segments, map) {
    return segments.filter((s) => map.has(s.take)).map((s) => ({ ...s, take: map.get(s.take) }));
  },

  // ── building ──────────────────────────────────────────────────────────────────────────

  /**
   * Get a track ready for a comp change: its storage fields, and the comp as the playlist LUNA
   * plays (fades go on the playing playlist, and a batch holds back a switch until it commits,
   * so this comes before the change's transaction).
   */
  async prepareComp(session, track, lane) {
    await AddOnLogic.ensureFields(session, track);
    if (session.playlistFor(track) !== lane) {
      await AddOnLogic.showPlaylist(session, track.id, lane.version.value);
      for (let i = 0; i < 100 && session.playlistFor(track) !== lane; i++) await new Promise((r) => setTimeout(r, 20));
    }
  },

  /**
   * Rewrite the comp playlist from `segments`, crossfade every seam, make it the playlist LUNA
   * plays, and save the list: one undo step.
   *
   * Only what changed is rewritten: a comp clip that is still right stays, with anything done
   * to it in LUNA (clip gain, its fades), and fades go only on the edges that changed. The whole
   * comp is rebuilt (every seam faded at `fadeMs`) when the page has no record of its clips (a
   * comp from before it kept one), when `fadeMs` differs from the length the comp was last
   * built with, or with `{ full: true }`.
   */
  async buildComp(session, track, lane, segments, options = {}) {
    await AddOnLogic.loadTakes(session, segments);
    const state = await AddOnLogic.warpState(session, track, lane, segments);
    await AddOnLogic.prepareComp(session, track, lane);
    let n = 0;
    await session.transaction('Swipe Comp', async () => { n = await AddOnLogic.writeComp(session, track, lane, segments, { ...options, ...state }); });
    return n;
  },

  /**
   * Comp an edit group together: the same sections on every track, each in its own takes (from
   * `members`: `[{ track, lane, map }]`, `map` from matchTakes; lane undefined until the track
   * has a SwipeComp), crossfaded at the same points, as one undo step. Each track keeps its own
   * SwipeComp and record, so it can be opened on its own later.
   */
  async buildGroupComp(session, lead, leadLane, members, segments, options = {}) {
    const all = [{ track: lead, lane: leadLane, list: segments }];
    const making = members.filter((m) => !m.lane);
    for (const m of members) {
      if (!m.lane) options.onStep?.(`Making a SwipeComp playlist on each grouped track (${making.indexOf(m) + 1} of ${making.length})...`);
      const lane = m.lane ?? await AddOnLogic.ensureCompLane(session, m.track);
      all.push({ track: m.track, lane, list: AddOnLogic.mapSegments(segments, m.map) });
    }
    for (const m of all) {
      await AddOnLogic.loadTakes(session, m.list);
      m.state = await AddOnLogic.warpState(session, m.track, m.lane, m.list);
      await AddOnLogic.prepareComp(session, m.track, m.lane);
    }
    const raise = AddOnLogic.keepsOnTop(session, lead);
    options.onStep?.('Building the comp...');
    await session.transaction('Swipe Comp', async () => {
      for (const m of all) await AddOnLogic.writeComp(session, m.track, m.lane, m.list, { ...options, raise, ...m.state });
    });
    return all.map((m) => m.lane);
  },

  /** The body of a comp change, inside the caller's transaction (see buildComp). */
  async writeComp(session, track, lane, segments, { fadeMs = 10, full = false, raise, warped, markers, legacy, left, refresh } = {}) {
    const list = AddOnLogic.merge(segments);
    const pieces = AddOnLogic.plan(session, list, warped, markers);
    if (AddOnLogic.isMidiTrack(track)) return AddOnLogic.writeMidiComp(session, track, lane, list, pieces, { raise });
    const store = AddOnLogic.store(session);
    const placedBefore = store.value(track.id, 'placed').value;
    const lastFade = AddOnLogic.savedFadeMs(session, track);
    const whole = full || !Array.isArray(placedBefore) || (lastFade !== undefined && lastFade !== fadeMs);
    const keptRecs = new Map();
    const keep = whole ? new Map() : AddOnLogic.reusableClips(lane, placedBefore, pieces, { legacy, left, refresh, recs: keptRecs });
    const before = AddOnLogic.neighboursOf(placedBefore);
    {
      // Keep SwipeComp at the top of LUNA's list, unless the user chose to leave it where it is.
      if (raise ?? AddOnLogic.keepsOnTop(session, track)) await AddOnLogic.raiseComp(session, track, lane);
      const kept = new Set(keep.values());
      for (const c of [...lane.clips.items]) if (!kept.has(c)) await c.delete();
      let placed = [];
      const ids = [], fresh = [], known = new Set([...keep.values()].map((c) => c.id));
      for (const [i, p] of pieces.entries()) {
        let clip = keep.get(i);
        if (clip) {
          if (clip.name.value !== p.name) await clip.name.set(p.name);
        } else if (p.warped) {
          // From a warped take: LUNA copies it, warps in place (see warpedTakeClips), then the clip
          // it made is found by its place, named after its take and crossfaded like any other.
          await AddOnLogic.contextCommand(session, 'promote_takes', { context_type: 'main', playlist_uid: [p.take], start: p.startTick, stop: p.stopTick });
          const uid = await AddOnLogic.clipMadeAt(session, lane, p.startTick, p.stopTick, known);
          if (uid) {
            clip = { id: uid };
            await session.client.raw.set(`${lane.path}/clips/${uid}/name`, p.name).catch(() => {});
          }
        } else {
          // Each comp clip is named after its take, so LUNA's own Timeline shows where it came from.
          clip = await session.insertClip({
            playlistUid: lane.id, copyOf: p.clip, startTick: p.startTick, stopTick: p.stopTick,
            sourceStartNs: p.sourceStartNs, sourceStopNs: p.sourceStopNs, name: p.name,
          });
        }
        ids.push(clip?.id);
        if (clip?.id) known.add(clip.id);
        fresh.push(!keep.has(i));
        // A piece LUNA copied from a warped take is recorded as LUNA's (`byLuna`): its warps are the
        // take's (see madeByLuna), with their fingerprint as copied (`sig`). A kept piece keeps its
        // record's kind and fingerprint (one behind its take still plays what it was copied with).
        // Should LUNA not show its clip, it is recorded by span alone.
        const prev = keptRecs.get(i);
        const lunaMade = prev ? (prev.byLuna || !prev.id) : p.warped;
        const sig = prev ? (prev.sig ?? legacy?.get(clip?.id)) : p.sig;
        if (placed && lunaMade) placed.push({ id: clip?.id ?? null, start: p.startTick, stop: p.stopTick, take: p.take, byLuna: true, ...(sig !== undefined ? { sig } : {}) });
        else if (placed && clip?.id) placed.push({ id: clip.id, start: p.startTick, stop: p.stopTick, take: p.take });
        else placed = null;   // no record rather than a wrong one
      }
      await store.set(track.id, 'placed', placed, { undoable: true });
      if (pieces.length && fadeMs > 0) {
        if (whole || ids.some((id) => !id)) {
          await lane.addFades({ startTick: pieces[0].startTick, stopTick: pieces[pieces.length - 1].stopTick, lengthNs: fadeMs * 1e6 });
        } else {
          const ops = AddOnLogic.fadeEdits(pieces, ids, fresh, before);
          if (ops.length) {
            const entries = AddOnLogic.fadeEntries(session, lane.id, pieces, ops, fadeMs);
            // Clear what is left at each changed edge (a kept clip's half of a crossfade to a clip
            // just deleted), only as far as the fade itself reaches, then fade it afresh.
            for (const { op, reach } of entries) {
              await AddOnLogic.contextCommand(session, 'delete_fades', { playlist_uid: [lane.id], start: op.at - reach - 1, stop: op.at + reach + 1 });
            }
            await AddOnLogic.contextCommand(session, 'set_fade', { clips: entries.map((e) => e.fade) });
          }
        }
      }
      await store.set(track.id, 'segments', list, { undoable: true });
    }
    return pieces.length;
  },

  /**
   * The body of a MIDI comp change, inside the caller's transaction. LUNA cannot copy part of a
   * MIDI clip that has no file behind it (insert_clip refuses it, measured on LUNA 3.1.2),
   * so each section is copied by LUNA's own comping command, promote_takes, which copies a
   * range of a take into the track's current playlist (the comp, made current beforehand by
   * prepareComp), notes in place, cut at the range. The whole comp is rewritten each time (no
   * fades to keep), with no crossfades: LUNA fades audio clips only. LUNA makes the clips, so
   * their ids are not known here; the record keeps their spans instead (see foreignClips).
   */
  async writeMidiComp(session, track, lane, list, pieces, { raise } = {}) {
    const store = AddOnLogic.store(session);
    if (raise ?? AddOnLogic.keepsOnTop(session, track)) await AddOnLogic.raiseComp(session, track, lane);
    for (const c of [...lane.clips.items]) await c.delete();
    for (const s of list) {
      if (!pieces.some((p) => p.take === s.take && p.stopTick > s.start && p.startTick < s.stop)) continue;
      await AddOnLogic.contextCommand(session, 'promote_takes', { context_type: 'main', playlist_uid: [s.take], start: s.start, stop: s.stop });
    }
    await store.set(track.id, 'placed', pieces.map((p) => ({ id: null, start: p.startTick, stop: p.stopTick, take: p.take })), { undoable: true });
    await store.set(track.id, 'segments', list, { undoable: true });
    return pieces.length;
  },

  /** Load the clips of the takes `segments` use (before a transaction: a batch holds reads back). */
  async loadTakes(session, segments) {
    for (const id of new Set(segments.map((s) => s.take))) await session.playlists.byId(id)?.clips.load();
  },
};

globalThis.AddOnLogic = AddOnLogic;
