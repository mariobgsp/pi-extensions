#!/usr/bin/env bash
# Prove install.sh reproduces this machine's layout, without touching it.
# Installs into a temp dir, then compares every path the kit manages.
set -uo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The real machine's global hook path must survive a test install.
before_hooks=$(git config --global core.hooksPath || true)

PI_HOME=$tmp/pi AGENTS_SKILLS_HOME=$tmp/agents/skills GIT_HOOKS_HOME=$tmp/hooks \
  "$repo/install.sh" >/dev/null || { echo "FAIL: install.sh exited non-zero"; exit 1; }

fail=0
expect_link() {
  local src=$1 dst=$2
  if [ ! -L "$dst" ]; then echo "FAIL: $dst is not a symlink"; fail=1; return; fi
  if [ "$(readlink -f "$dst")" != "$(readlink -f "$src")" ]; then
    echo "FAIL: $dst -> $(readlink -f "$dst"), expected $(readlink -f "$src")"; fail=1
  fi
}

expect_link "$repo/agent/AGENTS.md" "$tmp/pi/AGENTS.md"
expect_link "$repo/agent/mcp.json" "$tmp/pi/mcp.json"
for dir in extensions skills prompts themes; do
  for src in "$repo/agent/$dir"/*; do expect_link "$src" "$tmp/pi/$dir/${src##*/}"; done
done
for src in "$repo/skills"/*; do expect_link "$src" "$tmp/agents/skills/${src##*/}"; done
expect_link "$repo/git-hooks/prepare-commit-msg" "$tmp/hooks/prepare-commit-msg"

# settings.json is merged, not linked: packages must survive verbatim.
node - "$repo/agent/settings.json" "$tmp/pi/settings.json" <<'JS' || fail=1
const fs = require("node:fs");
const want = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const got = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
for (const p of want.packages) if (!got.packages.includes(p)) { console.log(`FAIL: package ${p} missing`); process.exit(1); }
for (const k of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) {
  if (want[k] !== got[k]) { console.log(`FAIL: ${k} is ${got[k]}, expected ${want[k]}`); process.exit(1); }
}
JS

# Re-running must not duplicate packages.
PI_HOME=$tmp/pi AGENTS_SKILLS_HOME=$tmp/agents/skills GIT_HOOKS_HOME=$tmp/hooks \
  "$repo/install.sh" >/dev/null || { echo "FAIL: second run exited non-zero"; exit 1; }
dupes=$(node -e 'const s=require(process.argv[1]);const p=s.packages;console.log(p.length-new Set(p).size)' "$tmp/pi/settings.json")
[ "$dupes" = 0 ] || { echo "FAIL: $dupes duplicate package(s) after re-run"; fail=1; }

after_hooks=$(git config --global core.hooksPath || true)
if [ "$before_hooks" != "$after_hooks" ]; then
  echo "FAIL: install changed global core.hooksPath ($before_hooks -> $after_hooks)"; fail=1
fi

if [ "$fail" = 0 ]; then echo "PASS: kit layout reproduced in $tmp"; fi
exit "$fail"
