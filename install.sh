#!/usr/bin/env bash
# Install this kit into a pi home. Idempotent: pull, then re-run.
#
#   ./install.sh
#
# Targets are overridable so the layout can be tested without touching the real one:
#   PI_HOME=~/.pi/agent  AGENTS_SKILLS_HOME=~/.agents/skills  GIT_HOOKS_HOME=~/.config/git/hooks
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
pi_home=${PI_HOME:-$HOME/.pi/agent}
ambient=${AGENTS_SKILLS_HOME:-$HOME/.agents/skills}
git_hooks=${GIT_HOOKS_HOME:-$HOME/.config/git/hooks}
stamp=$(date +%Y%m%d-%H%M%S)

# Link src at dst. Anything real already there is moved aside, never deleted.
link() {
  local src=$1 dst=$2
  mkdir -p -- "$(dirname -- "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    mv -- "$dst" "$dst.pre-kit-$stamp"
    printf 'moved aside: %s -> %s\n' "$dst" "$dst.pre-kit-$stamp"
  fi
  ln -sfn -- "$src" "$dst"
}

link "$repo/agent/AGENTS.md" "$pi_home/AGENTS.md"
link "$repo/agent/mcp.json" "$pi_home/mcp.json"

for dir in extensions skills prompts themes; do
  for src in "$repo/agent/$dir"/*; do
    if [ -e "$src" ]; then link "$src" "$pi_home/$dir/${src##*/}"; fi
  done
done

for src in "$repo/skills"/*; do
  if [ -e "$src" ]; then link "$src" "$ambient/${src##*/}"; fi
done

# pi writes settings.json itself, so merge the kit's keys into it instead of linking.
if command -v node >/dev/null 2>&1; then
  node - "$repo/agent/settings.json" "$pi_home/settings.json" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [src, dst] = process.argv.slice(2);
const want = JSON.parse(fs.readFileSync(src, "utf8"));
let cur = {};
try { cur = JSON.parse(fs.readFileSync(dst, "utf8")); } catch {}
const out = { ...cur };
out.packages = [...new Set([...(cur.packages ?? []), ...(want.packages ?? [])])];
for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "hideThinkingBlock"]) {
  if (want[key] !== undefined) out[key] = want[key];
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, `${JSON.stringify(out, null, 2)}\n`);
JS
else
  printf 'no node on PATH: copying settings.json unmerged\n'
  cp -- "$repo/agent/settings.json" "$pi_home/settings.json"
fi

link "$repo/git-hooks/prepare-commit-msg" "$git_hooks/prepare-commit-msg"
if [ "$(git config --global core.hooksPath || true)" != "$git_hooks" ]; then
  git config --global core.hooksPath "$git_hooks"
fi

# omarchy-app ships with the OS, so point at the system copy when it is there.
for target in "$pi_home/skills/omarchy-app" "$ambient/omarchy-app"; do
  if [ -d /usr/share/omarchy/default/agents/skills/omarchy-app ]; then
    link /usr/share/omarchy/default/agents/skills/omarchy-app "$target"
  else
    printf 'skip (no omarchy): %s\n' "$target"
  fi
done

printf '\ninstalled into %s and %s\n' "$pi_home" "$ambient"
printf 'start pi once to install the npm packages listed in settings.json:\n'
printf '  %s\n' "$(jq -r '.packages[]' "$pi_home/settings.json" 2>/dev/null || echo "see $pi_home/settings.json")"
