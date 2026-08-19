# Deploy n8n from scratch on a fresh VM

One script bootstraps a brand-new, empty Ubuntu/Debian VM (AWS EC2 or GCP
Compute Engine) into a fully working, HTTPS-secured n8n instance and imports
every workflow in this repository.

```text
Internet  →  :443 (HTTPS)  →  Nginx + Let's Encrypt  →  :5678 (HTTP)  →  n8n
```

Nginx terminates TLS; n8n only ever listens on internal port `5678`.

## What the script does

`n8n-bootstrap.sh` runs unattended (reads `n8n.env`, never prompts) and:

1. Installs Node.js, n8n (global npm), nginx, certbot.
2. Creates a dedicated `n8n` system user and data folder (`/opt/n8n`).
3. Generates/persists an n8n encryption key.
4. Configures nginx as a reverse proxy for your domain (WebSocket-ready).
5. Opens a firewall (`ufw`) for SSH + HTTP/HTTPS only — `5678` stays internal.
6. Obtains a Let's Encrypt certificate and forces HTTP→HTTPS redirect.
7. Installs and enables a `systemd` service so n8n survives reboots.
8. Imports every `*.json` workflow from the repo root.

It is **idempotent** — safe to re-run.

## Prerequisites (do these first)

1. **Create the VM** (AWS or GCP), Ubuntu 22.04/24.04 LTS recommended.
2. **Open ports 80 and 443** in the cloud firewall:
   - GCP: a VPC firewall rule allowing TCP `80,443`.
   - AWS: inbound rules on the security group for TCP `80,443` (and `22`).
   - Do **not** expose `5678` publicly.
3. **Point DNS at the VM**: create an `A` record for your domain
   (e.g. `n8n-job-switch.cloud`) → the VM's external IP. Verify:
   ```bash
   ping n8n-job-switch.cloud
   ```

## Run it

On the VM:

```bash
git clone <this-repo-url> n8n-workflow-lib
cd n8n-workflow-lib
cp deploy/n8n.env.example deploy/n8n.env
nano deploy/n8n.env          # set DOMAIN, LETSENCRYPT_EMAIL, timezone, etc.
sudo ./deploy/n8n-bootstrap.sh
```

The script prints the final URL and next steps when finished.

## After it finishes

1. Open `https://<your-domain>` and create the owner account.
2. Re-add the **Google (Sheets/Drive) OAuth** credential under
   **Settings → Credentials**. In Google Cloud Console, set the authorized
   redirect URI to:
   ```text
   https://<your-domain>/rest/oauth2-credential/callback
   ```
3. Open each imported workflow, select the reconnected credential on the
   Google nodes, and **Activate** the ones you want running.

> Credentials are intentionally **not** imported (they're encrypted per-key and
> tied to OAuth consent). Only workflow definitions are imported.

## Configuration reference

All settings live in `deploy/n8n.env` — see `n8n.env.example` for the full,
commented list. Required: `DOMAIN`, `LETSENCRYPT_EMAIL`. Everything else has a
sensible default.

> ⚠️ **Back up `N8N_ENCRYPTION_KEY`.** If left blank, the script generates one
> and saves it to `/opt/n8n/.n8n-encryption-key`. You need the *same* key on any
> future reinstall or your stored credentials become unrecoverable.

## Managing the instance

```bash
sudo systemctl status n8n          # service state
journalctl -u n8n -f               # live logs
sudo systemctl restart n8n         # restart
sudo certbot certificates          # cert status
sudo certbot renew --dry-run       # test auto-renewal
sudo ss -lntp | grep 5678          # confirm n8n is on the internal port
```

## Re-importing / adding workflows later

Drop more `*.json` files in the repo root and re-run the script, or import a
single file manually:

```bash
sudo -u n8n env N8N_USER_FOLDER=/opt/n8n N8N_ENCRYPTION_KEY="$(sudo cat /opt/n8n/.n8n-encryption-key)" \
  n8n import:workflow --input="/path/to/workflow.json"
sudo systemctl restart n8n
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `certbot failed` | DNS isn't pointing at the VM yet, or ports 80/443 are blocked by the cloud firewall. Fix DNS/firewall and re-run. |
| Site loads but shows "secure cookie" error | You reached it over `http://…:5678`. Always use `https://<domain>`. |
| Workflows imported but nodes show credential errors | Expected — reconnect the Google OAuth credential (see above). |
| Editor won't load / WebSocket errors | Confirm nginx `Upgrade`/`Connection` headers (already in the generated config) and that the service is running. |
