# Vendored Moebius bitmap fonts

The `ibm/`, `amiga/` and `c64/` directories beside this file are a copy of the
bitmap fonts shipped with **Moebius** (Modern ANSI Art Editor) by Andy Herbert
and contributors. jockoshop serves them so that a piece of art opens in the
font its SAUCE record asks for, instead of always in IBM VGA.

- Upstream: <https://github.com/blocktronics/moebius>
- Version: `1.0.29`
- Commit: `1f624d62654d614177635ab18a288253c3b917eb` ("Update electron-builder.yml to
  use universal arch for dmg target", 2023-12-18)
- Copied from the local read-only checkout at
  `/Volumes/Crucial2TB/Projects/vsCode_moebius/vendor/moebius/app/fonts/`
- Licence: Apache-2.0, `LICENSE.txt` beside this file (copied verbatim from the
  upstream repository root).

## What was copied

| here | upstream | changed? |
| --- | --- | --- |
| `ibm/` (60 files) | `app/fonts/ibm/` | no — byte-for-byte |
| `amiga/` (8 files) | `app/fonts/amiga/` | no — byte-for-byte |
| `c64/` (2 files) | `app/fonts/c64/` | no — byte-for-byte |
| `LICENSE.txt` | `LICENSE.txt` | no |

File names are kept exactly as upstream, spaces and apostrophes included
(`mO'sOul.F16`, `PETSCII shifted.F08`), so the provenance stays checkable; the
loader URL-encodes them.

Each file is a raw bitmap: 256 glyphs, 8 pixels wide, one byte per row, so the
byte count gives the cell height — `.F08` = 2048, `.F14` = 3584, `.F16` = 4096,
`.F19` = 4864. There is no header.

## The name table

`packages/core/src/fonts.ts` maps SAUCE font names onto these files. It was
generated from the `lookup_url` switch in upstream `app/libtextmode/font.js`
and carries 90 of that switch's 156 names.

The other 66 were dropped because **Moebius names fonts it does not ship**:
`CP720`, `CP819`, `CP858`, `CP872`, `CP867` (KAM), `CP667` (MAZ), `CP790`,
`CP895`, `CP991`, `atari/atascii.F08`, and most of the `.F19` (VGA25G)
variants. Listing those would mean offering a font that then fails to load, so
`resolveFontName` treats them as unknown: the document keeps the name it was
given — an export still records what the art asks for — and the picture is
drawn in IBM VGA with a note saying so.
