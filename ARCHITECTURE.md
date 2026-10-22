# Architecture

A self-hosted player for learning Japanese from anime: the home Linux box
serves episodes, subtitles and dictionary lookups; an iPad/iPhone browser plays
them over WireGuard, looks words up by tapping subtitles, and creates Anki cards
through AnkiConnect on the same box.

Single user, single server, trusted network. Anything that only matters for
multiple users, public exposure or other platforms is out of scope.

## Shape

```
            iPad Safari                                  Linux box
 ┌──────────────────────────────┐   HTTP (shared/api)  ┌──────────────────────────────┐
 │ client/                      │ ───────────────────▶ │ server/http   (routing only) │
 │   main      wiring, effects  │                      │      │                       │
 │   state     State + reduce   │                      │      ▼                       │
 │   views     render State     │                      │ server/adapters  (all I/O)   │
 └──────────────┬───────────────┘                      │   library  ffmpeg  dictionary│
                │                                      │   anki                       │
                ▼                                      └──────┬───────────────────────┘
            core/  (pure functions, used by both sides) ◀─────┘
```

Logic lives in `core/` as pure functions. Everything that touches the outside
world (files, processes, network, DOM, the video element) sits at the edges and
calls into `core/`. The edges stay thin: they gather inputs, call a pure
function, and carry out what it decided.

## Modules

Each module has one public entry: `name.ts` while it is a single file, or
`name/index.ts` once it needs several. Its exported types and doc comments are
the whole contract; nothing imports a module's other files.

### `src/core/` — pure, shared by client and server

| Module | Responsibility |
|---|---|
| `subtitles` | Parse ASS/SRT into `Cue[]`; cues active at a time; merge pieces that share a time span. |
| `scan` | From a tap position in a cue, the text to look up; from a match length, the characters to highlight. |
| `library` | From a directory listing, which files are episodes of which series and which subtitle files belong to each, by language. |
| `card` | From the looked-up term, the current cue, the rendered definition HTML and a field template: the Anki note fields and the screenshot time / audio clip window. Never renders HTML itself. |

### `src/shared/api.ts` — the client/server contract

Request and response types for every HTTP endpoint. The client and server
depend on each other only through this file.

### `src/server/`

| Module | Responsibility |
|---|---|
| `main.ts` | Reads config, constructs adapters, starts HTTP. Wiring only. |
| `http` | Maps routes to adapter and core calls; validation and status codes. No domain logic. |
| `adapters/library` | Scans the media roots, keeps the episode index (via `core/library`). |
| `adapters/media` | ffmpeg: whole-episode remux into `cache/` on first request, screenshots, audio clips; LRU cache. |
| `adapters/dictionary` | Yomitan importer and translator over a SQLite store. |
| `adapters/anki` | AnkiConnect calls: store media (by file path, same machine), add notes, find existing notes. |
| `adapters/store` | Durable user state under `state/`: config, playback positions, mined-card history. |

### `src/client/`

| Module | Responsibility |
|---|---|
| `state.ts` | `State`, `Action`, `Effect`, and `reduce(state, action) => {state, effects}`. The only global state. |
| `main.ts` | The loop: events become actions, `reduce` produces the next state and a list of effects, views render the state, effects run. |
| `effects.ts` | Executes `Effect` values: fetch, video element commands, timers. Results come back as actions. |
| `views/*` | `render(state, dispatch)` per region: player, subtitles, lookup panel, controls. No state of their own beyond the DOM. |

**State and the `<video>` element.** The video element is the single source of
truth for `currentTime`, `paused` and buffering; `State` never stores them.
`State` holds user intent and discrete derived values: open panel, lookup
history, request sequence numbers, ids of the cues on screen. A
`requestAnimationFrame` loop dispatches only when the set of on-screen cue ids
changes. The progress bar and time label are updated by the player view
straight from the element, outside `reduce`. Play, pause and seek are effects;
their outcome returns through the element's events as actions. Lookup responses
carry the sequence number of their request and are dropped by `reduce` when
stale.

## Invariants

1. `core/` imports nothing outside `core/`: no `node:*`, no DOM, no `fetch`.
   A test enforces this.
2. The client has exactly one mutable value, the current `State`. Only `reduce`
   produces new states; views and effects never modify it.
3. Client and server share types only through `shared/api.ts` and `core/`.
4. Yomitan code is used unmodified and imported only by `adapters/dictionary`
   (server) and `views/panel` (client, bundled by esbuild). A test enforces this.
5. An episode's id is derived from its media root's name and its path relative
   to that root, so ids survive restarts and rescans. Renaming a file loses its
   playback position; that is accepted.
6. `cache/` holds derived data (dictionary database, episode index, remuxed
   episodes, screenshots, clips) and can be deleted at any time; it is rebuilt
   on demand. `state/` holds what cannot be rebuilt (config, playback
   positions, mined-card history) and is never deleted by the program.
7. Definition HTML for cards is produced in the browser, where Yomitan's
   renderer has a DOM, and sent to the server with the card request. The server
   never renders structured content.

## Key decisions

**TypeScript, no framework.** Types make the contracts above checkable.
The server runs `.ts` directly on Node (type stripping, so only erasable syntax:
no `enum`, `namespace` or parameter properties; `tsconfig` sets
`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`; imports always
carry the `.ts` extension). The client is bundled by esbuild into one file,
including `core/` and the Yomitan renderer. The UI is a handful of regions redrawn from `State`;
a framework would add more than it saves.

**Yomitan as a git submodule** (`vendor/yomitan`), pinned to a commit. Its
lookup logic depends on the database only through a narrow interface, so the
dictionary adapter provides that interface over SQLite (`node:sqlite`) and
reuses the importer and translator as they are. Upgrading Yomitan is one commit.
Yomitan's own `build:libs` pulls a git dependency, which the local npm config
forbids, so `scripts/build-yomitan-libs` bundles only the libraries we use
(zip.js, schema validators, kanji processor) from pinned npm packages into the
git-ignored `vendor-build/`. Yomitan is JavaScript; `adapters/dictionary`
declares minimal types for the parts it exposes, and tsc never checks
`vendor/`. Dictionaries are imported by an explicit `npm run import-dicts`,
not on server start.

**Playback: whole-episode remux into a cached MP4, served with HTTP ranges.**
Safari cannot open MKV, so each episode is remuxed once into an MP4 under
`cache/`, streams copied, not re-encoded:
`-map 0:v:0 -map 0:a:<first jpn track, else first> -dn -sn -map_chapters -1
-c copy -tag:v hvc1`. Subtitles always come from the sidecar files, never from
the MP4; fonts, chapters and extra audio tracks are dropped. The iPad decodes
10-bit HEVC in hardware.

Copying is disk-bound: a 1 GB episode took 1.3 s with a warm page cache; a cold
read from the NVMe media disk adds roughly a second. Remux starts when an
episode is selected or offered for resume (prewarm), and the next episode is
prefetched; the player shows a "preparing" state while it waits. The file is
written to `<id>.mp4.tmp` and renamed when complete; concurrent requests for the
same episode share one remux. The output uses `+faststart`: on the iPad it starts
and seeks almost instantly, while fragmented MP4 stuttered badly.

Audio stays FLAC: confirmed on the device that Safari plays FLAC in MP4, so
there is no transcoding path.

Seeking, buffering and range retries are Safari's native progressive playback.
On the device, dropping WireGuard, seeking ten minutes ahead and reconnecting
resumed playback immediately.
The source is reloaded at the current position only on an `error` event, or
when `waiting` lasts over 8 s with `readyState < 3`; `stalled` alone is normal
and ignored. After reloading, the position is set on `loadedmetadata`, and
playback resumes only if it was playing before. The cache is bounded by an LRU
size limit set in `state/config` (default 50 GB); files still being written are
never evicted.

HLS was considered and rejected for now: with copied video, segments can only
cut at keyframes, a seekable VOD playlist must be computed from the keyframe
index before segments exist, timestamps must stay continuous across separate
ffmpeg runs, and AAC priming shifts audio against subtitles. It would only be
worth that cost if progressive playback cannot recover from network drops on
the device.

**Lookups and card creation on the server.** The server has the dictionary,
the source video for screenshots and audio clips, and network access to
AnkiConnect, so the browser never talks to AnkiConnect directly and needs no
CORS setup.

## Testing

- `core/`: unit tests for every exported function (`node --test`).
- Edges (`server/`, adapters): HTTP-level tests against a running server with
  fixture media and a small fixture dictionary. Remuxed files are checked with
  ffprobe: exactly one video stream tagged `hvc1` and one audio stream, no
  data, subtitle or attachment streams, duration equal to the source.
- Visual behaviour is checked by the user on the device. Playback
  compatibility is also device-only; changes to media handling go through the
  device checklist in `AGENTS.md`.
