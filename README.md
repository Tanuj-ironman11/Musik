# Musik

Musik is a free, open-source desktop music player. It plays everything at full quality (FLAC, WAV, MP3, AIFF, OGG, OPUS, AAC, M4A, ALAC) with no compression or quality caps, and it has a real mod/theme system built into the core instead of bolted on as an afterthought — basically what Millennium does for Steam or Spicetify does for Spotify, but native from day one.

No ads, no subscriptions, no telemetry. GPLv3 licensed — free and open, and any fork or redistribution has to stay that way too. Mods are a different story (see below).

The default look is a dark, glassmorphic UI, but that's just the starting point — mods can reskin pretty much all of it.

This app was coded over many weeks with the help of Claude, and every update rolled out has been tested. That doesn't mean it's perfect, though. Make sure to report any bugs you see in the Issues tab!

## Features

- Full-quality playback, no internal resampling or compression
- Web Audio `AnalyserNode` wired in for visualizer support
- Native mod system — sandboxed, hot-reloadable, doesn't require touching core files
- Metadata tagging, cover art extraction/fetching, and audio fingerprinting (AcoustID/MusicBrainz)
- Lyrics via LRCLIB, with a Lyrica fallback
- Last.fm scrobbling
- Miniplayer, fullscreen mode, customizable sidebar

## Installing (prebuilt)

Download the latest installer or portable `.exe` from the [Releases](../../releases) page and run it. That's it.

## Installing from source

You'll need:
- [Node.js](https://nodejs.org/) (LTS)
- [Git](https://git-scm.com/)
- **Windows only:** Visual Studio Build Tools with the "Desktop development with C++" workload (or `windows-build-tools`), needed to compile the native WASAPI addon

Then:

```bash
git clone https://github.com/Tanuj-ironman11/Musik.git
cd Musik
npm install
```

If you're on Windows and want the game-audio ducking feature, also build the native addon:

```bash
cd native/wasapi-loopback
npm install
npm run build
cd ../..
```

Not on Windows? Skip that step — the app runs fine without it, you just lose the WASAPI ducking feature.

Then just start it:

```bash
npm start
```

To build your own installer:

```bash
npm run dist:win
```

Output goes to `dist/`, which isn't tracked in git.

## Mods

Mods live here:

```
%AppData%\musik-mods
```

Drop a mod folder in, then hit **Rescan mods** in Settings. A mod folder looks like:

```
my-theme/
  manifest.json
  theme.css
  index.js
```

`theme.css` gets injected into the page, `index.js` runs sandboxed after the DOM's ready. Mods talk to the app through `window.Musik`, which exposes player control, library/queue access, UI injection, theming, and events.

Mods loaded through this API run in their own sandbox, are distributed separately from Musik itself, and are **not required to be GPL-licensed** — mod authors can license their own mods however they like, including keeping them closed-source or paid. See the additional-permission note at the bottom of [LICENSE](LICENSE) for the exact terms. This does not apply to forks or redistributions of Musik's own source, which stay under GPLv3.

## Contributing

Still actively being built, so expect some rough edges here and there. Issues and PRs are welcome — just know the codebase moves fast between commits, so it's worth checking current file state before diving into a big change.

## License

GNU GPLv3 — see [LICENSE](LICENSE). TL;DR: free and open source forever, forks/redistributions must stay that way too, but mods loaded through the public API are exempt (see LICENSE for details).
