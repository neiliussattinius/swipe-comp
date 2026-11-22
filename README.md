# Swipe Comp

An add-on for Universal Audio LUNA that lets you do swipe-comping for tracks.

Swipe Comp is a full LUNA page that shows every take on a track at once, stacked like a take
folder. Drag across the part of a take you want, and it goes into the comp, crossfaded at every
seam. It works the way Quick Swipe Comping works in Logic Pro.

Needs LUNA 3.1.2 or newer. Tested on macOS; not yet on Windows.

## Installing

Any one of these:

- Download `Swipe-Comp-<version>.lunaaddon` from the latest release on this page and
  double-click it.
- In LUNA's Add On showcase, import this repo by its address,
  `https://github.com/neiliussattinius/swipe-comping`. LUNA reads the latest release, and checks
  for a newer one each time it starts.
- If someone shared the `.lunaaddon` with you by a Dropbox, Google Drive or iCloud Drive link,
  import that link the same way.

Then open it from LUNA's Add Ons menu, under Apps. LUNA may need a relaunch before a newly
installed Add On shows in the menu.

## Using it

- Pick a track in the Track menu. Every audio track is listed with its number of takes. Each
  loop-record pass in LUNA is a playlist, and each playlist is a take here. Newest takes are at
  the top, as in LUNA's Timeline, and each take keeps its own colour.
- Drag across a take to use that stretch of it in the comp. Click a take to switch the comp
  section under the pointer to that take. Drag the edge of a section, or a seam in the comp
  row, to move it.
- The Silence strip under the comp row: swipe across it to make that stretch silent, or click
  it to silence the section above. Option-drag on a take (Alt-drag on Windows) does the same.
- "Fill gaps from" fills every empty part of the comp with one take, keeping the sections you
  chose. On an empty comp it is "Start from", which starts the comp from a whole take.
- Tidy appears when swipes have left tiny gaps or scraps (under 100 ms). It lists each one,
  and you choose which neighbouring take fills it, silence, or to leave it alone.
- Click a take's name to hear that take alone; click Comp to hear the comp. Double-click a
  take's name to rename it (LUNA's playlist menu shows the new name too).
- Space or Play plays and stops. Solo solos the track. Click the ruler to move the playhead.
  Cmd+scroll (Ctrl+scroll on Windows) or pinch zooms; sideways scroll moves along.
- Snap uses LUNA's own Grid setting and switch, so it snaps where LUNA's Timeline would.
- LUNA's markers show above the bar numbers, with a line in each marker's colour down through
  the takes. Click one to move the playhead there.
- Every change is one step in LUNA's own undo history. Undo and Redo are in the header too,
  named after the step they would take.

## Grouped tracks

When the track is in a LUNA group that is switched on and has Edit ticked, its tracks comp only
together, never one alone: every change makes the same sections on each grouped audio track,
each from its own matching take, crossfaded at the same points, as one undo step. A drum kit's
mics, or a bass DI and amp, stay together. When the track is in a group without that (switched
off, or Edit not ticked), Swipe Comp asks once whether to comp the group together or just this
track; the "Comp the group" box in the header changes the answer.

As in Logic, grouped tracks comp together only when they have the same number of takes, and
take 1 goes with take 1, take 2 with take 2, and so on. Take 1 has the same colour on every
track, take 2 another. An empty New Version is not counted. In a group with Edit on whose takes
don't match, Swipe Comp shows what to fix instead of the takes: give every track the same number
of takes, or turn off Edit for the group to comp one track at a time. In a group without Edit
whose takes don't match, it comps only the track you're on. Clicking a take's name plays that
take on every grouped track, and renaming a take renames its match on each one.

Comping a group, the grouped tracks show below this track's takes, as in Logic, each after a
dark band in its track colour: a header row with its own comp, drawn from its own recording.
Click a grouped track's name to show or hide its takes; you can swipe on those too, and the whole group follows. Double-click
it to make it the track you're working on.

Group comping has been tried in LUNA on a group made from a copied track, not yet on a group
recorded together (a drum kit, say). Reports welcome.

## Things to know

- The comp is an ordinary LUNA playlist named "SwipeComp" on the track, made the first time
  you swipe. It plays without the Add On. Your takes are never edited.
- Comp clips are named after their takes, so LUNA's Timeline shows where every piece came from.
- A swipe changes only what it touches. Clip gain or a crossfade you edited in LUNA's Timeline
  stays until a swipe moves that piece or seam.
- If SwipeComp holds clips the page didn't put there (a recording, say), the page asks before
  replacing them.
- LUNA has no waveform for a take until it has been on the Timeline. When the page opens a
  track it shows each such take for a moment, which leaves one undo step, "Draw take
  waveforms", that changes nothing.
- Audio tracks only for now. MIDI comping is not built yet.
- Takes are assumed not to be time-stretched. Warped takes are not supported.
- What the page remembers (the comp's sections, which playlist is SwipeComp) is saved inside
  the LUNA session.

## Feedback

Please use this repo's Issues page: what you did, what you expected, and what happened. Your
LUNA version and computer help.

## Building it yourself

Node 22 or newer.

```sh
npm install
npm test                  # runs against the SDK's simulated LUNA; no LUNA needed
```

Running it against LUNA, installing it from source, and packing it use UA's `ua-builder`, which
comes with UA's LUNA Builder SDK plugin for Claude Code
(`/plugin marketplace add uaudio-labs/luna-builder-sdk`, then install ua-luna-builder).
`tools/ua-builder.mjs` finds it there, or in a folder named by `LUNA_BUILDER_SDK`.

```sh
npm run serve             # http://localhost:8790/ with LUNA running
npm run install-addon     # link it into LUNA's Add Ons folder
npm run release           # dist/Swipe-Comp-<version>.lunaaddon, built from the last commit
```

| File | What it is |
|---|---|
| `index.html`, `main.js` | The page: drawing, swipes, connecting to LUNA. |
| `logic.js` | The comp rules and building the comp. No page code; tested. |
| `tests/` | Tests against the SDK's simulated LUNA. |
| `vendor/` | UA's LUNA Builder SDK bundle, under UA's Apache 2.0 license (`vendor/LICENSE`, `vendor/NOTICE`). |
| `tools/` | Finding UA's `ua-builder`, and building the release file. |

## License

Swipe Comp is under the MIT License (`LICENSE`). The SDK bundle in `vendor/` is Universal
Audio's, under the Apache License 2.0.

LUNA is a trademark of Universal Audio, Inc., and Logic Pro of Apple Inc. Swipe Comp is an
independent add-on, not made or endorsed by either.
