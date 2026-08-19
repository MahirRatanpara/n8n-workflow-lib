#!/usr/bin/env bash
# =============================================================================
# n8n-bootstrap.sh
#
# Provision n8n from scratch on a fresh, empty Ubuntu/Debian VM (AWS or GCP):
#   1. Install Node.js, n8n (global npm), nginx, certbot
#   2. Create a dedicated service user + data folder
#   3. Configure nginx reverse proxy  (443 -> localhost:5678)
#   4. Obtain a Let's Encrypt certificate and force HTTPS redirect
#   5. Install + start a systemd service for n8n
#   6. Import every workflow JSON found in this repository
#
# Reads all configuration from deploy/n8n.env (see n8n.env.example).
# Runs unattended — no interactive prompts. Safe to re-run (idempotent).
#
# Usage (on the VM, from a checkout of this repo):
#   cp deploy/n8n.env.example deploy/n8n.env && edit it, then:
#   sudo ./deploy/n8n-bootstrap.sh
# =============================================================================

set -euo pipefail

# --- locate script + repo ----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${N8N_ENV_FILE:-${SCRIPT_DIR}/n8n.env}"

# --- logging helpers ---------------------------------------------------------
log()  { printf '\033[1;34m[n8n-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[n8n-setup] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[n8n-setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------
[[ "${EUID}" -eq 0 ]] || die "Run as root (use: sudo $0)."
[[ -f "${ENV_FILE}" ]] || die "Config file not found: ${ENV_FILE}
  Copy deploy/n8n.env.example to deploy/n8n.env and fill it in."

command -v apt-get >/dev/null 2>&1 || die "This script targets Debian/Ubuntu (apt-get not found)."

# --- load + validate config --------------------------------------------------
log "Loading config from ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${DOMAIN:?Set DOMAIN in n8n.env}"
: "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL in n8n.env}"

N8N_SERVICE_USER="${N8N_SERVICE_USER:-n8n}"
N8N_USER_FOLDER="${N8N_USER_FOLDER:-/opt/n8n}"
N8N_PORT="${N8N_PORT:-5678}"
GENERIC_TIMEZONE="${GENERIC_TIMEZONE:-UTC}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-false}"
BASIC_AUTH="${BASIC_AUTH:-false}"
N8N_VERSION="${N8N_VERSION:-}"

# --- DNS sanity check --------------------------------------------------------
if [[ "${SKIP_DNS_CHECK}" != "true" ]]; then
  log "Checking that ${DOMAIN} resolves to this VM..."
  public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  resolved_ip="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -n1 || true)"
  if [[ -z "${resolved_ip}" ]]; then
    die "${DOMAIN} does not resolve. Create an A record pointing to this VM's public IP first, or set SKIP_DNS_CHECK=true."
  fi
  if [[ -n "${public_ip}" && "${resolved_ip}" != "${public_ip}" ]]; then
    warn "${DOMAIN} resolves to ${resolved_ip} but this VM's public IP looks like ${public_ip}."
    warn "Certbot will fail unless DNS points here. Continuing because DNS may be behind a proxy/NAT..."
  else
    log "DNS OK (${DOMAIN} -> ${resolved_ip})."
  fi
fi

# --- 1. system packages ------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
log "Updating apt and installing base packages..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg openssl build-essential python3 ufw nginx certbot python3-certbot-nginx

# --- 2. Node.js via NodeSource ----------------------------------------------
if command -v node >/dev/null 2>&1 && [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge "${NODE_MAJOR}" ]]; then
  log "Node.js $(node -v) already present."
else
  log "Installing Node.js ${NODE_MAJOR}.x ..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "node $(node -v) / npm $(npm -v)"

# --- 3. install n8n globally -------------------------------------------------
n8n_pkg="n8n"
[[ -n "${N8N_VERSION}" ]] && n8n_pkg="n8n@${N8N_VERSION}"
if command -v n8n >/dev/null 2>&1 && [[ -z "${N8N_VERSION}" ]]; then
  log "n8n already installed ($(n8n --version 2>/dev/null || echo unknown)); skipping npm install. Re-run with N8N_VERSION set to upgrade."
else
  log "Installing ${n8n_pkg} (this can take a few minutes)..."
  npm install -g "${n8n_pkg}"
fi
N8N_BIN="$(command -v n8n)"
log "n8n binary: ${N8N_BIN} (version $(n8n --version 2>/dev/null || echo unknown))"

# --- 4. service user + data folder ------------------------------------------
if ! id -u "${N8N_SERVICE_USER}" >/dev/null 2>&1; then
  log "Creating system user ${N8N_SERVICE_USER}..."
  useradd --system --create-home --home-dir "${N8N_USER_FOLDER}" --shell /usr/sbin/nologin "${N8N_SERVICE_USER}"
fi
mkdir -p "${N8N_USER_FOLDER}"
chown -R "${N8N_SERVICE_USER}:${N8N_SERVICE_USER}" "${N8N_USER_FOLDER}"

# --- 5. encryption key -------------------------------------------------------
KEY_FILE="${N8N_USER_FOLDER}/.n8n-encryption-key"
if [[ -z "${N8N_ENCRYPTION_KEY:-}" ]]; then
  if [[ -f "${KEY_FILE}" ]]; then
    N8N_ENCRYPTION_KEY="$(cat "${KEY_FILE}")"
    log "Reusing existing encryption key from ${KEY_FILE}."
  else
    N8N_ENCRYPTION_KEY="$(openssl rand -hex 24)"
    warn "No N8N_ENCRYPTION_KEY set — generated one. BACK IT UP (also saved to ${KEY_FILE}):"
    warn "    ${N8N_ENCRYPTION_KEY}"
  fi
fi
printf '%s' "${N8N_ENCRYPTION_KEY}" > "${KEY_FILE}"
chown "${N8N_SERVICE_USER}:${N8N_SERVICE_USER}" "${KEY_FILE}"
chmod 600 "${KEY_FILE}"

# --- 6. nginx reverse proxy --------------------------------------------------
log "Writing nginx site for ${DOMAIN}..."
cat > /etc/nginx/sites-available/n8n <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # Allow large payloads (file uploads, big workflow executions)
    client_max_body_size 50m;

    location / {
        proxy_pass http://localhost:${N8N_PORT};
        proxy_http_version 1.1;

        # WebSocket / SSE support (n8n push, editor live updates)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP \$remote_addr;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/n8n /etc/nginx/sites-enabled/n8n
[[ -e /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# --- 7. firewall -------------------------------------------------------------
log "Configuring ufw (allow SSH + Nginx Full; n8n port ${N8N_PORT} stays internal)..."
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
# Do NOT open ${N8N_PORT} publicly — it is proxied via nginx only.
yes | ufw enable >/dev/null 2>&1 || true

# --- 8. Let's Encrypt certificate -------------------------------------------
log "Obtaining/renewing Let's Encrypt certificate for ${DOMAIN}..."
certbot --nginx \
  -d "${DOMAIN}" \
  --non-interactive --agree-tos \
  -m "${LETSENCRYPT_EMAIL}" \
  --redirect --keep-until-expiring \
  || die "certbot failed. Check that ${DOMAIN} points to this VM and ports 80/443 are open in the cloud firewall (GCP VPC / AWS security group)."

# --- 9. systemd service ------------------------------------------------------
log "Writing systemd unit /etc/systemd/system/n8n.service..."
basic_auth_env=""
if [[ "${BASIC_AUTH}" == "true" ]]; then
  : "${BASIC_AUTH_USER:?Set BASIC_AUTH_USER when BASIC_AUTH=true}"
  : "${BASIC_AUTH_PASSWORD:?Set BASIC_AUTH_PASSWORD when BASIC_AUTH=true}"
  basic_auth_env=$(cat <<EOF
Environment="N8N_BASIC_AUTH_ACTIVE=true"
Environment="N8N_BASIC_AUTH_USER=${BASIC_AUTH_USER}"
Environment="N8N_BASIC_AUTH_PASSWORD=${BASIC_AUTH_PASSWORD}"
EOF
)
fi

cat > /etc/systemd/system/n8n.service <<UNIT
[Unit]
Description=n8n Workflow Automation
After=network.target

[Service]
Type=simple
User=${N8N_SERVICE_USER}
Group=${N8N_SERVICE_USER}
WorkingDirectory=${N8N_USER_FOLDER}

Environment="N8N_HOST=${DOMAIN}"
Environment="N8N_PORT=${N8N_PORT}"
Environment="N8N_PROTOCOL=https"
Environment="N8N_EDITOR_BASE_URL=https://${DOMAIN}/"
Environment="WEBHOOK_URL=https://${DOMAIN}/"
Environment="N8N_SECURE_COOKIE=true"
Environment="N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}"
Environment="N8N_USER_FOLDER=${N8N_USER_FOLDER}"
Environment="GENERIC_TIMEZONE=${GENERIC_TIMEZONE}"
Environment="N8N_DIAGNOSTICS_ENABLED=false"
Environment="NODE_ENV=production"
${basic_auth_env}

ExecStart=${N8N_BIN} start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable n8n >/dev/null 2>&1

# --- 10. import workflows ----------------------------------------------------
# Import while the service is stopped to avoid SQLite write contention.
log "Importing repository workflows..."
mapfile -t workflow_files < <(find "${REPO_ROOT}" -maxdepth 1 -type f -name '*.json' | sort)
if [[ "${#workflow_files[@]}" -eq 0 ]]; then
  warn "No *.json workflow files found in ${REPO_ROOT}; skipping import."
else
  systemctl stop n8n >/dev/null 2>&1 || true
  import_dir="$(mktemp -d)"
  # Copy with safe names (n8n import dislikes spaces less than the shell does; keep robust).
  i=0
  for f in "${workflow_files[@]}"; do
    cp "${f}" "${import_dir}/workflow_${i}.json"
    i=$((i + 1))
  done
  chown -R "${N8N_SERVICE_USER}:${N8N_SERVICE_USER}" "${import_dir}"
  log "Found ${#workflow_files[@]} workflow file(s); importing..."
  sudo -u "${N8N_SERVICE_USER}" \
    env N8N_ENCRYPTION_KEY="${N8N_ENCRYPTION_KEY}" \
        N8N_USER_FOLDER="${N8N_USER_FOLDER}" \
        GENERIC_TIMEZONE="${GENERIC_TIMEZONE}" \
    "${N8N_BIN}" import:workflow --separate --input="${import_dir}" \
    || warn "Workflow import reported an error — check output above. You can re-import later from the n8n UI."
  rm -rf "${import_dir}"
fi

# --- 11. start service -------------------------------------------------------
log "Starting n8n service..."
systemctl restart n8n
sleep 3
systemctl --no-pager --lines=0 status n8n || true

# --- done --------------------------------------------------------------------
cat <<DONE

=============================================================================
 n8n is provisioned.

   URL:            https://${DOMAIN}
   Data folder:    ${N8N_USER_FOLDER}
   Service user:   ${N8N_SERVICE_USER}
   Encryption key: ${KEY_FILE}   (BACK THIS UP)

 Next steps:
   1. Open https://${DOMAIN} and create the owner account.
   2. Re-add the Google (Sheets/Drive) OAuth credential in Settings > Credentials.
      Set the OAuth redirect URL in Google Cloud to:
        https://${DOMAIN}/rest/oauth2-credential/callback
   3. Open each imported workflow and select the reconnected credential.
   4. Activate the workflows you want running.

 Handy commands:
   systemctl status n8n
   journalctl -u n8n -f
   sudo certbot certificates
=============================================================================
DONE
