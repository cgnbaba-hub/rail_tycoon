#!/usr/bin/env bash
# Iron Baron: one-time server setup (safe to run again). Run as root on a Debian/Ubuntu or
# RHEL-like server with systemd:
#
#   curl -fsSL https://raw.githubusercontent.com/cgnbaba-hub/rail_tycoon/claude/iron-baron-tycoon-fd4aap/deploy/setup-vps.sh | sudo bash
#
# Options (environment): BRANCH (default claude/iron-baron-tycoon-fd4aap), PORT (8085),
# REPO_URL (https://github.com/cgnbaba-hub/rail_tycoon.git). An existing
# /etc/iron-baron.conf wins over them; edit that file to change branch or port later.
#
# What it sets up:
#   user `ironbaron`, checkout in /opt/iron-baron/repo, releases in /opt/iron-baron/releases,
#   /opt/iron-baron/current -> the release being served,
#   iron-baron-web.service     static server on 127.0.0.1:PORT
#   iron-baron-update.timer    every 2 minutes: new commit? -> npm ci, test, build, publish
# The tunnel (Cloudflare or other) is not touched; point it at http://localhost:PORT.
set -euo pipefail

# Everything runs inside main(), so `curl … | bash` has read the whole script before it starts.
main() {
BASE=/opt/iron-baron
APP_USER=ironbaron
CONF=/etc/iron-baron.conf

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() {
  printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "please run as root (sudo bash setup-vps.sh)"
command -v systemctl >/dev/null || die "systemd is needed"

# -- settings ---------------------------------------------------------------------------
if [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
  say "Using $CONF (branch $BRANCH, port $PORT)"
else
  REPO_URL=${REPO_URL:-https://github.com/cgnbaba-hub/rail_tycoon.git}
  BRANCH=${BRANCH:-claude/iron-baron-tycoon-fd4aap}
  PORT=${PORT:-8085}
  cat >"$CONF" <<EOF
# Iron Baron deployment settings. After editing: sudo -u $APP_USER $BASE/update --force
REPO_URL=$REPO_URL
BRANCH=$BRANCH
PORT=$PORT
BASE=$BASE
# 1 = only publish commits whose tests pass (recommended), 0 = skip the tests
RUN_TESTS=1
KEEP=3
EOF
  say "Wrote $CONF (branch $BRANCH, port $PORT)"
fi

# -- packages ---------------------------------------------------------------------------
say "Packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates util-linux >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q git curl ca-certificates util-linux
fi
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 18 ]; then
  say "Installing Node.js 22"
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    dnf install -y -q nodejs
  else
    die "please install Node.js 18 or newer and run this again"
  fi
fi
NODE=$(command -v node)
echo "node $($NODE --version), npm $(npm --version), git $(git --version | cut -d' ' -f3)"

# -- earlier installations -------------------------------------------------------------
others=$(systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -i -E 'iron|baron|rail.?tycoon' | grep -v -E '^iron-baron-(web\.service|update\.service|update\.timer)$' || true)
if [ -n "$others" ]; then
  printf '\nNote: other units that look like an earlier install of the game:\n%s\n' "$others"
  echo "If they serve or update the game too, stop them: systemctl disable --now <unit>"
fi

# -- port check -------------------------------------------------------------------------
if command -v ss >/dev/null && ss -ltnH "sport = :$PORT" | grep -q .; then
  if ! systemctl is-active --quiet iron-baron-web; then
    ss -ltnp "sport = :$PORT" || true
    die "port $PORT is already in use. Run again with another port, e.g.: PORT=8086 bash setup-vps.sh (or edit $CONF)"
  fi
fi

# -- user and checkout ------------------------------------------------------------------
say "User and checkout"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$BASE/releases"
chown "$APP_USER:" "$BASE" "$BASE/releases"
# An earlier install may have left files owned by someone else, or a plain `current` folder.
[ -d "$BASE/repo" ] && chown -R "$APP_USER:" "$BASE/repo"
if [ -e "$BASE/current" ] && [ ! -L "$BASE/current" ]; then
  mv "$BASE/current" "$BASE/current.old-$(date +%Y%m%d%H%M%S)"
  echo "moved the old $BASE/current folder aside"
fi
as_app() { runuser -u "$APP_USER" -- env HOME="$BASE" "$@"; }

if [ ! -d "$BASE/repo/.git" ]; then
  if as_app git ls-remote --quiet "$REPO_URL" >/dev/null 2>&1 && ! as_app git ls-remote --exit-code --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
    die "branch $BRANCH does not exist in $REPO_URL — set BRANCH in $CONF (e.g. BRANCH=main) and run again"
  fi
  if ! as_app git clone --quiet --branch "$BRANCH" "$REPO_URL" "$BASE/repo"; then
    # Private repository: a read-only deploy key just for this server.
    key=$BASE/.ssh/id_ed25519
    if [ ! -f "$key" ]; then
      as_app mkdir -p "$BASE/.ssh"
      as_app ssh-keygen -q -t ed25519 -N '' -C "iron-baron@$(hostname)" -f "$key"
      as_app sh -c "ssh-keyscan -t ed25519 github.com >> '$BASE/.ssh/known_hosts' 2>/dev/null"
    fi
    ssh_url=$(echo "$REPO_URL" | sed -E 's#https://github.com/([^/]+)/([^/.]+)(\.git)?#git@github.com:\1/\2.git#')
    sed -i "s#^REPO_URL=.*#REPO_URL=$ssh_url#" "$CONF"
    cat <<EOF

The repository could not be cloned over HTTPS (private?). Add this public key as a
READ-ONLY deploy key: GitHub -> rail_tycoon -> Settings -> Deploy keys -> Add deploy key

$(cat "$key.pub")

Then run this script again.
EOF
    exit 2
  fi
else
  as_app git -C "$BASE/repo" remote set-url origin "$REPO_URL"
fi

# -- scripts and units ------------------------------------------------------------------
say "Services"
install -o "$APP_USER" -m 644 "$BASE/repo/deploy/serve.mjs" "$BASE/serve.mjs"
# The updater always runs the newest update.sh from the checkout (copied first, because the
# update itself rewrites the checkout).
cat >"$BASE/update" <<EOF
#!/usr/bin/env bash
cp "$BASE/repo/deploy/update.sh" "$BASE/.update-run.sh"
exec bash "$BASE/.update-run.sh" "\$@"
EOF
chown "$APP_USER:" "$BASE/update"
chmod 755 "$BASE/update"

cat >/etc/systemd/system/iron-baron-web.service <<EOF
[Unit]
Description=Iron Baron game (static files on 127.0.0.1:$PORT)
After=network.target

[Service]
User=$APP_USER
EnvironmentFile=$CONF
Environment=HOST=127.0.0.1
ExecStart=$NODE $BASE/serve.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadOnlyPaths=$BASE
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/iron-baron-update.service <<EOF
[Unit]
Description=Iron Baron: publish the newest commit of the configured branch
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$APP_USER
Environment=HOME=$BASE
Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$BASE/update
Nice=10
TimeoutStartSec=30min
EOF

cat >/etc/systemd/system/iron-baron-update.timer <<EOF
[Unit]
Description=Iron Baron: check for a new commit every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload

# -- first build ------------------------------------------------------------------------
say "First build (npm ci, tests, build — takes a few minutes)"
as_app env PATH="$(dirname "$NODE"):$PATH" "$BASE/update" --force

systemctl enable --now iron-baron-web.service >/dev/null
systemctl restart iron-baron-web.service
systemctl enable --now iron-baron-update.timer >/dev/null
sleep 1

say "Check"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$code" = 200 ] || die "the local server answered $code — see: journalctl -u iron-baron-web -n 50"
echo "http://127.0.0.1:$PORT/ -> 200, serving $(cat "$BASE/current/version.txt")"

cat <<EOF

Done. The game runs on http://localhost:$PORT and updates itself within ~2 minutes of
every push to $BRANCH (only when the tests and the build pass).

Point your tunnel at it, for example Cloudflare:
  - tunnel managed in the dashboard: Zero Trust -> Networks -> Tunnels -> your tunnel ->
    Public Hostname -> Add: your hostname, Service HTTP, URL localhost:$PORT
  - tunnel with a config file (/etc/cloudflared/config.yml): add above the final
    "- service: http_status:404" line
        - hostname: game.example.com
          service: http://localhost:$PORT
    then: cloudflared tunnel route dns <tunnel-name> game.example.com
          systemctl restart cloudflared

Useful:
  served version      cat $BASE/current/version.txt   (or https://<hostname>/version.txt)
  update log          journalctl -u iron-baron-update -n 50
  update now          sudo systemctl start iron-baron-update
  rebuild anyway      sudo -u $APP_USER $BASE/update --force
  other branch/port   edit $CONF, then: sudo systemctl restart iron-baron-web &&
                      sudo -u $APP_USER $BASE/update --force
EOF
}

main "$@"
