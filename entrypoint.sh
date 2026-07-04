#!/bin/sh
set -e

REPO_URL="https://github.com/Open-Labor-Foundation/labor-commons.git"
CLONE_DIR="/labor-commons"
KEEPER_DIR="/commons-keeper"

CATALOG_INTERVAL_SECONDS="${KEEPER_CATALOG_INTERVAL_SECONDS:-3600}"
SECURITY_INTERVAL_SECONDS="${KEEPER_SECURITY_INTERVAL_SECONDS:-86400}"

# Authenticate git via gh's credential helper, which reads GH_TOKEN from the
# environment at request time. This avoids embedding the token in the repo's
# remote URL / .git/config, where it would persist on disk and risk surfacing
# in git output or logs.
gh auth setup-git

mkdir -p "$KEEPER_DIR/state" "$KEEPER_DIR/reports"

run_catalog_pass() {
  # Clone or pull labor-commons
  if [ -d "$CLONE_DIR/.git" ]; then
    echo "Pulling latest labor-commons..."
    git -C "$CLONE_DIR" pull --ff-only
  else
    echo "Cloning labor-commons..."
    git clone --depth=1 "$REPO_URL" "$CLONE_DIR"
  fi

  # Link keeper state and reports into the labor-commons worktree
  ln -sf "$KEEPER_DIR/state"   "$CLONE_DIR/state"
  ln -sf "$KEEPER_DIR/reports" "$CLONE_DIR/reports"

  # All scripts must run from the labor-commons root so process.cwd()
  # resolves catalog/, governance/, state/, and reports/ correctly.
  (
    cd "$CLONE_DIR"
    node "$KEEPER_DIR/src/improve-catalog.mjs" \
      --mode "${KEEPER_MODE:-passive}" \
      --trigger "${KEEPER_TRIGGER:-schedule}" \
      "$@"
    node "$KEEPER_DIR/src/create-spec-pack-issues.mjs"
  )
}

run_security_pass() {
  (
    cd "$KEEPER_DIR"
    node src/security-review.mjs
  )
}

catalog_loop() {
  while true; do
    run_catalog_pass "$@" || echo "catalog pass failed — will retry in ${CATALOG_INTERVAL_SECONDS}s"
    sleep "$CATALOG_INTERVAL_SECONDS"
  done
}

security_loop() {
  while true; do
    run_security_pass || echo "security-review pass failed — will retry in ${SECURITY_INTERVAL_SECONDS}s"
    sleep "$SECURITY_INTERVAL_SECONDS"
  done
}

catalog_loop "$@" &
security_loop &

wait
