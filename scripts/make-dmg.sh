#!/bin/sh
# Packages the built jockoshop.app into a DMG with plain hdiutil — no Finder
# scripting, so no macOS automation prompt. Tauri's own DMG step arranges the
# window with AppleScript and needs permission to control Finder; this skips that.
#   scripts/make-dmg.sh   (after: npm run desktop:build)
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
bundle="$root/packages/desktop/src-tauri/target/release/bundle"
app="$bundle/macos/jockoshop.app"
[ -d "$app" ] || { echo "no app at $app — run npm run desktop:build first" >&2; exit 1; }
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/packages/desktop/src-tauri/tauri.conf.json" | head -1)
arch=$(uname -m)
out="$bundle/dmg/jockoshop_${version}_${arch}.dmg"
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
mkdir -p "$bundle/dmg"
rm -f "$out"
hdiutil create -quiet -volname jockoshop -srcfolder "$stage" -ov -format UDZO "$out"
rm -rf "$stage"
echo "$out  $(du -h "$out" | cut -f1)"
