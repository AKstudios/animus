#!/bin/sh
# Copies a skill named in plugin/vendor/sources.yaml from its repo at the
# commit recorded there. Edit the commit in sources.yaml first, after reading
# the upstream diff. Usage: scripts/vendor-skill.sh <name>
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
name=${1:?usage: scripts/vendor-skill.sh <name>}
read_field() {
  node --disable-warning=ExperimentalWarning -e '
    const { parse } = require(process.argv[1] + "/plugin/node_modules/yaml");
    const s = parse(require("fs").readFileSync(process.argv[1] + "/plugin/vendor/sources.yaml", "utf8"))[process.argv[2]];
    if (!s) { console.error("no skill " + process.argv[2] + " in sources.yaml"); process.exit(1); }
    const v = s[process.argv[3]];
    console.log(Array.isArray(v) ? v.join("\n") : v ?? "");
  ' "$root" "$name" "$1"
}
repo=$(read_field repo); commit=$(read_field commit); strip=$(read_field strip)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git init -q "$tmp" && git -C "$tmp" fetch -q --depth 1 "$repo" "$commit" && git -C "$tmp" checkout -q FETCH_HEAD
dest="$root/plugin/vendor/$name"
rm -rf "$dest" && mkdir -p "$dest"
read_field paths | while IFS= read -r p; do
  [ -n "$p" ] || continue
  rel=${p#"$strip"}
  mkdir -p "$dest/$(dirname "$rel")"
  cp -R "$tmp/$p" "$dest/$rel"
done
echo "$name at $commit copied to $dest"
