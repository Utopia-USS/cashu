#!/usr/bin/env bash
# Fast architecture check of ONE TypeScript file (target < 3 s), for agents and the PostToolUse hook.
#
#   tools/claude-dev/scripts/check-file.sh <path>     check a file, print violations, exit 1 on any
#   tools/claude-dev/scripts/check-file.sh --hook     hook mode: read the Claude Code PostToolUse JSON
#                                                     from stdin; exit 2 with the report on stderr so
#                                                     the agent sees it, exit 0 when clean / out of scope
#
# Runs: Biome (safe fixes applied: format, import order; then the per-folder import bans), the
# dependency-cruiser rules for this file's own imports, and ESLint react-hooks for React files.
# The whole-repo version is `pnpm arch:check`. Rules: the cashu-ts-architecture and cashu-ui skills.
set -u

hook=0
if [[ "${1:-}" == "--hook" ]]; then
  hook=1
  payload="$(cat)"
  file="$(printf '%s' "$payload" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); process.stdout.write(j?.tool_input?.file_path ?? ""); } catch {}
    });' 2>/dev/null)"
else
  file="${1:-}"
fi

[[ -n "$file" ]] || { ((hook)) && exit 0; echo "usage: check-file.sh <path> | --hook" >&2; exit 64; }
case "$file" in
  *.ts | *.tsx | *.cts | *.mts) ;;
  *) exit 0 ;;
esac
[[ -f "$file" ]] || exit 0
file="$(cd "$(dirname -- "$file")" && pwd)/$(basename -- "$file")"

# Scope guard: the nearest ancestor whose package.json is the cashU TS monorepo root (works in any
# checkout or worktree folder name).
root="$(dirname -- "$file")"
while [[ "$root" != "/" ]]; do
  if [[ -f "$root/package.json" && -f "$root/pnpm-workspace.yaml" ]] && grep -q '"name": "cashu-ts"' "$root/package.json"; then
    break
  fi
  root="$(dirname -- "$root")"
done
[[ "$root" != "/" ]] || exit 0
rel="${file#"$root"/}"
case "$rel" in
  packages/* | apps/* | tools/arch/*) ;;
  *) exit 0 ;;
esac
case "$rel" in
  */node_modules/* | */dist/*) exit 0 ;;
esac
[[ -x "$root/tools/arch/node_modules/.bin/eslint" ]] || {
  echo "check-file: tools/arch is not installed (run pnpm install); skipped $rel" >&2
  exit 0
}

cd "$root" || exit 0
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cashu-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# dependency-cruiser and ESLint start in the background while Biome runs.
node --disable-warning=ExperimentalWarning --experimental-strip-types tools/arch/src/depcruise.ts "$rel" \
  >"$tmp/dep" 2>&1 &
dep_pid=$!
eslint_pid=""
case "$rel" in
  *.tsx | */use[A-Z]*.ts)
    tools/arch/node_modules/.bin/eslint --config tools/arch/eslint.config.js --max-warnings=0 \
      --cache --cache-location node_modules/.cache/eslint-arch/ --format stylish "$rel" >"$tmp/eslint" 2>&1 &
    eslint_pid=$!
    ;;
esac

failed=0
report=""
add() { report+="$1"$'\n'; failed=1; }

node_modules/.bin/biome check --write --colors=off --max-diagnostics=30 "$rel" >"$tmp/biome" 2>&1 \
  || add "== Biome ($rel)"$'\n'"$(grep -vE '^(Checked|Fixed|Found) ' "$tmp/biome")"
wait "$dep_pid" || add "== dependency-cruiser"$'\n'"$(cat "$tmp/dep")"
if [[ -n "$eslint_pid" ]]; then
  wait "$eslint_pid" || add "== ESLint react-hooks / React Compiler"$'\n'"$(cat "$tmp/eslint")"
fi

((failed)) || exit 0
{
  echo "cashU arch check: violations in $rel"
  printf '%s' "$report"
  echo "Fix the cause (the message names the rule and the way out); rules are explained in the"
  echo "cashu-ts-architecture and cashu-ui skills. Never silence a rule to get green (lab rule 7)."
} >&2
((hook)) && exit 2
exit 1
