# Vendored Moebius collaboration server

This directory contains a copy of part of **Moebius** (Modern ANSI Art Editor) by
Andy Herbert and contributors, used by killerdraw's tests so that killerdraw's
"joint" client is verified against the genuine collaboration server rather than a
replica of it.

- Upstream: <https://github.com/blocktronics/moebius>
- Version: `1.0.29` (`package.json` of the checkout below)
- Commit: `1f624d62654d614177635ab18a288253c3b917eb` ("Update electron-builder.yml to
  use universal arch for dmg target", 2023-12-18)
- Copied from the local read-only checkout at
  `/Volumes/Crucial2TB/Projects/vsCode_moebius/vendor/moebius/`
- Licence: Apache-2.0, `LICENSE.txt` beside this file (copied verbatim from the
  upstream repository root).

## What was copied

| here | upstream | changed? |
| --- | --- | --- |
| `app/server.js` | `app/server.js` | two patches, below |
| `app/hourly_saver.js` | `app/hourly_saver.js` | verbatim |
| `app/libtextmode/*.js` | `app/libtextmode/*.js` | verbatim (all 9 files: `ansi`, `binary_text`, `canvas`, `encodings`, `font`, `libtextmode`, `palette`, `textmode`, `xbin`) |
| `LICENSE.txt` | `LICENSE.txt` | verbatim |

Everything `app/server.js` and `app/libtextmode/libtextmode.js` require was followed
transitively; those are the only upstream files needed. Upstream's own `server.js`
(the CLI wrapper) was **not** copied: it pulls in `express` and `minimist` for the
optional web client, which this rig does not serve. `start.mjs` here replaces it.

## Files added by killerdraw (not from upstream)

- `app/discord_stub.js` — see patch 1.
- `package.json` — `ws` 8.15 and `upng-js` 2.1, the versions upstream's `package.json`
  pins. `"type": "commonjs"`, because killerdraw's root `package.json` says
  `"type": "module"` and the copied files are CommonJS.
- `rig.mjs`, `start.mjs`, `NOTICE.md`.

## Patches to `app/server.js`

Two, both marked with a `killerdraw patch` comment in the file. Nothing else was
touched — no protocol, message-shape or save behaviour was changed.

1. **`require("discord.js")` → `require("./discord_stub")`.** Upstream requires
   `discord.js` at the top of the file purely to construct a `WebhookClient` for the
   optional `--discord` webhook relay, which is never constructed unless a webhook URL
   is passed. `discord_stub.js` provides a `WebhookClient` class with an async no-op
   `send()`, which keeps `discord.js` and its dependency tree out of this copy.

2. **`server` added to `module.exports`.** `start_joint()` does
   `if (!server.address()) server.listen(server_port)` and does not wait for the
   `listening` event, so a caller that passes port `0` has no way to learn which port
   it got. The rig therefore listens on the exported http server itself, awaits
   `listening`, reads `address().port`, and then calls `start_joint()` — which sees a
   bound address and skips its own `listen`.

## libtextmode under plain Node

It loads with **no stubbing at all**. `libtextmode/canvas.js` does use
`document.createElement("canvas")` and `libtextmode.js` uses
`window.requestAnimationFrame`, but only inside function bodies (`create_canvas`,
`join_canvases`, `next_frame`/`animate`, the `render_*` family). Nothing browser-facing
runs at require time, and the four entry points the server uses — `read_file`,
`write_file`, `compress`, `resize_canvas` (plus `new_document`/`uncompress` for tests)
— never reach them. Verified on Node 20.20.0.

(`libtextmode/textmode.js` defines an unused `$(name)` helper that calls
`document.getElementById`; it is dead code in this copy.)
