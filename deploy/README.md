# Running Iron Baron on a server

The game is a static web app. `setup-vps.sh` puts it on a Linux server with systemd and keeps
it up to date: every 2 minutes it checks the branch, and when there is a new commit it runs
`npm ci`, the tests and the build, then switches the served release in one step. A commit whose
tests or build fail is never published; the previous version stays online.

## Install (once)

```bash
curl -fsSL https://raw.githubusercontent.com/cgnbaba-hub/rail_tycoon/claude/iron-baron-tycoon-fd4aap/deploy/setup-vps.sh | sudo bash
```

Options: `curl … | sudo BRANCH=main PORT=8086 bash`. The script installs git and Node.js 22 if
needed, creates the user `ironbaron`, checks out the repository to `/opt/iron-baron/repo`,
builds it and starts:

| Unit | What it does |
|---|---|
| `iron-baron-web.service` | serves `/opt/iron-baron/current` on `127.0.0.1:8085` |
| `iron-baron-update.timer` | runs `iron-baron-update.service` every 2 minutes |

Settings live in `/etc/iron-baron.conf` (branch, port, whether to run the tests, releases
kept). If the repository is private, the script prints a read-only deploy key to add on
GitHub and stops; run it again afterwards.

## Tunnel

The server only listens on localhost. Point your tunnel at `http://localhost:8085`, e.g. a
Cloudflare tunnel: *Zero Trust → Networks → Tunnels → (tunnel) → Public Hostname → Add*, service
`HTTP`, URL `localhost:8085`. With a config file (`/etc/cloudflared/config.yml`), add an ingress
rule above the final `- service: http_status:404`:

```yaml
  - hostname: game.example.com
    service: http://localhost:8085
```

then `cloudflared tunnel route dns <tunnel> game.example.com` and `systemctl restart cloudflared`.

## Everyday

```bash
cat /opt/iron-baron/current/version.txt        # commit being served (also /version.txt on the site)
journalctl -u iron-baron-update -n 50          # what the updater did
sudo systemctl start iron-baron-update         # check for a new commit now
sudo -u ironbaron /opt/iron-baron/update --force   # rebuild even without a new commit
systemctl list-timers iron-baron-update.timer  # when it runs next
```

Switching branch (e.g. to `main` once the work is merged): edit `BRANCH=` in
`/etc/iron-baron.conf`, then run the `--force` update. Changing the port also needs
`sudo systemctl restart iron-baron-web` and the tunnel pointed at the new port.

To remove everything: `systemctl disable --now iron-baron-web iron-baron-update.timer`, delete
the three unit files in `/etc/systemd/system/`, `/etc/iron-baron.conf`, `/opt/iron-baron` and the
user `ironbaron`.
