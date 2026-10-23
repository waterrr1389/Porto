# Kotoba Player

Watch your own anime in Safari on iPad or iPhone, tap any word in the
Japanese subtitles to look it up with your Yomitan dictionaries, and turn it
into an Anki card in one tap.

Self-hosted and single-user, meant for a home LAN or WireGuard. There is no
authentication; do not expose it to the internet.

## Requirements

- Linux server with Node.js 26+, ffmpeg/ffprobe on `PATH`, and git
- Safari on iPadOS / iOS 17+
- Yomitan dictionary `.zip` files
- For card mining: Anki with [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
  on the same machine, and the [Lapis](https://github.com/donkuri/lapis) note type
- Optional: the Local Audio Server for Yomichan add-on, for word audio

## Installation

```sh
git clone --recurse-submodules git@github.com:waterrr1389/Porto.git kotoba-player
cd kotoba-player
npm ci
npm run build:yomitan

# Dictionaries: file name order in dicts/ is the priority order
mkdir -p dicts && cp ~/Downloads/jitendex.zip dicts/10-jitendex.zip
npm run import-dicts
# or import a Yomitan "Export Dictionary Collection" backup
npm run import-yomitan -- backup.json [--only "A,B"] [--exclude "C"]

npm run build
npm start                 # http://0.0.0.0:8090, PORT=... to change
```

Already-imported dictionaries are skipped, so both import commands can be
re-run after adding more.

## Configuration

The first start writes `state/config.json`; edit it and restart.

```json
{
  "mediaRoots": ["/srv/anime"],
  "cacheLimitGB": 20,
  "anki": { "url": "http://127.0.0.1:8765", "apiKey": null, "deck": "JP::Mining", "model": "Lapis" },
  "localAudio": { "url": "http://127.0.0.1:5050" },
  "dictionaryOrder": ["Jitendex", "明鏡国語辞典 第三版"]
}
```

- `mediaRoots`: renaming a root resets playback positions in it.
- `cacheLimitGB`: remuxed episodes beyond this are evicted, least recently used first.
- `localAudio`: set to `null` to disable word audio.
- `dictionaryOrder`: titles listed here come first; the rest follow import order.

## Media

Each directory under a media root is a series; episode numbers come from file
names (`[05]`, ` - 05`, `S01E05`, …). Videos are remuxed, not re-encoded, so
the device must decode the source codecs (H.264, HEVC incl. 10-bit, AAC and
FLAC work on iPad).

Subtitles are sidecar ASS/SRT files named after the video with a language tag,
or text tracks embedded in the MKV:

```
[Group] Show [01].mkv
[Group] Show [01].ja.ass    → Japanese, tappable   (ja, jp, jpn)
[Group] Show [01].sc.ass    → Simplified Chinese   (sc, chs, zh, zh-Hans)
[Group] Show [01].tc.ass    → Traditional Chinese  (tc, cht, zh-Hant, big5)
```

The track choice is saved per series.

## Usage

Open `http://<server>:8090` in Safari; **Add to Home Screen** runs it full
screen.

- Tap a Japanese subtitle character to look up the word starting there;
  **制卡** creates a card with sentence, screenshot and audio clip.
  「已有 N 张」 means the deck already has that word.
- Hold the picture for 2×, swipe sideways to seek.
- The side menu jumps to the previous / next line.

## Data

`state/` holds config, playback progress, subtitle choices and the card log:
back it up. Everything in `cache/`, `dist/` and `vendor-build/` can be
deleted and rebuilt (re-run `import-dicts` for `cache/dictionaries.sqlite`).

## Development

```sh
npm run check   # type check
npm test        # node --test; media tests need ffmpeg
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) before
changing code.

## Troubleshooting

- **「准备中…」 never ends**: the remux failed; check the server log.
- **Lookups return nothing**: no dictionaries imported.
- **「Anki 未连接」**: Anki is not running, or `anki.apiKey` does not match
  AnkiConnect's config.
