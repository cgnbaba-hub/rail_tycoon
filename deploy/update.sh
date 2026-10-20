#!/usr/bin/env bash
# Iron Baron: publish the newest commit of the configured branch.
#
# Fetches the branch; if its commit differs from the one being served, checks it out, runs
# `npm ci`, the tests and the build, copies dist/ into releases/<commit>/ and moves the
# `current` symlink there in one step. If anything fails, the old release stays online and
# that commit is not retried until something new is pushed (or --force is given).
#
#   update.sh            update if the branch moved
#   update.sh --force    rebuild and republish even if nothing changed
#
# Settings come from /etc/iron-baron.conf (or $IRON_BARON_CONF): REPO_URL, BRANCH, BASE,
# RUN_TESTS (1/0), KEEP (releases to keep).
set -euo pipefail

CONF=${IRON_BARON_CONF:-/etc/iron-baron.conf}
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
BASE=${BASE:-/opt/iron-baron}
BRANCH=${BRANCH:-main}
RUN_TESTS=${RUN_TESTS:-1}
KEEP=${KEEP:-3}
REPO=$BASE/repo
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { echo "[iron-baron $(date -u +%FT%TZ)] $*"; }

exec 9>"$BASE/.update.lock"
if ! flock -n 9; then
  log "another update is still running"
  exit 0
fi

cd "$REPO"
[ -n "${REPO_URL:-}" ] && git remote set-url origin "$REPO_URL"
git fetch --quiet origin "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
cur=$(cut -d' ' -f1 "$BASE/current/version.txt" 2>/dev/null || true)
failed=$(cat "$BASE/.failed" 2>/dev/null || true)

if [ "$FORCE" = 0 ]; then
  [ "$new" = "$cur" ] && exit 0
  if [ "$new" = "$failed" ]; then
    exit 0 # already failed once; wait for the next push
  fi
fi

log "building ${new:0:10} from $BRANCH (serving ${cur:0:10})"
fail() {
  echo "$new" >"$BASE/.failed"
  log "FAILED at: $1 — still serving ${cur:0:10}"
  exit 1
}
git checkout --quiet --force --detach "$new" || fail checkout
git clean -fdq
npm ci --no-audit --no-fund --loglevel=error || fail "npm ci"
if [ "$RUN_TESTS" = 1 ]; then
  npm test --silent || fail "npm test"
fi
npm run build --silent || fail "npm run build"

rel=$BASE/releases/$new
rm -rf "$rel.tmp"
cp -a dist "$rel.tmp"
echo "$new $(date -u +%FT%TZ) $BRANCH" >"$rel.tmp/version.txt"
rm -rf "$rel"
mv "$rel.tmp" "$rel"
ln -sfn "$rel" "$BASE/current.tmp"
mv -Tf "$BASE/current.tmp" "$BASE/current"
rm -f "$BASE/.failed"

# The static server script ships with the repo; take the new one along (used after a restart).
if [ -f deploy/serve.mjs ] && ! cmp -s deploy/serve.mjs "$BASE/serve.mjs"; then
  cp deploy/serve.mjs "$BASE/serve.mjs"
  log "serve.mjs changed — takes effect after: systemctl restart iron-baron-web"
fi

# Keep the newest $KEEP releases (never the one being served).
live=$(readlink -f "$BASE/current")
ls -1dt "$BASE"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$live" ] || rm -rf "$old"
done

log "now serving ${new:0:10}"
