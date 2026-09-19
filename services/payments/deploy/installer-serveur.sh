#!/usr/bin/env bash
# =============================================================================
#  Serveur de paiement Timora — installation et durcissement (Ubuntu 24.04 LTS)
# =============================================================================
#  A lancer UNE fois, en root, depuis ce dossier copie sur le serveur :
#
#    sudo bash installer-serveur.sh --email-acme vous@exemple.com --admin <utilisateur> \
#         [--domaine payments.timora.tech] [--ip-admin <votre IPv4 fixe>]
#
#  Installe : mises a jour de securite automatiques, Node.js 24 LTS et Caddy
#  (depots officiels signes), utilisateur de service sans shell, service
#  systemd durci, HTTPS Let's Encrypt, pare-feu UFW (80/443 publics, SSH
#  limite), fail2ban, SSH par cle seulement (si une cle est deja en place).
#  Aucune base de donnees n'est installee ni exposee sur ce serveur.
#  Rejouable sans risque.
# =============================================================================
set -euo pipefail

DOMAINE="payments.timora.tech"
EMAIL_ACME=""
ADMIN=""
IP_ADMIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domaine) DOMAINE="$2"; shift 2 ;;
    --email-acme) EMAIL_ACME="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --ip-admin) IP_ADMIN="$2"; shift 2 ;;
    *) echo "Option inconnue : $1"; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "A lancer en root : sudo bash $0 ..."; exit 1; }
if [ -z "$EMAIL_ACME" ] || [ -z "$ADMIN" ]; then
  echo "Usage : sudo bash $0 --email-acme vous@exemple.com --admin <utilisateur> [--domaine payments.timora.tech] [--ip-admin <IPv4>]"
  exit 1
fi
echo "$DOMAINE" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$' || { echo "Domaine invalide : $DOMAINE"; exit 1; }
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "Attention : script prevu pour Ubuntu 24.04 LTS (systeme trouve : ${PRETTY_NAME:-inconnu})."
fi
ICI="$(cd "$(dirname "$0")" && pwd)"
etape() { printf '\n==> %s\n' "$1"; }

etape "Mises a jour du systeme"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl gnupg ufw fail2ban unattended-upgrades \
  apt-transport-https debian-keyring debian-archive-keyring

etape "Mises a jour de securite automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

etape "Horloge synchronisee (signatures horodatees, certificats)"
timedatectl set-ntp true || true

etape "Node.js 24 LTS (depot NodeSource signe)"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update -q
apt-get -y -q install nodejs
node --version

etape "Caddy (depot officiel signe)"
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -q
apt-get -y -q install caddy

etape "Utilisateur de service et dossiers"
id timora-pay >/dev/null 2>&1 || useradd --system --home-dir /opt/timora-payments --no-create-home \
  --shell /usr/sbin/nologin timora-pay
install -d -m 0755 -o root -g root /opt/timora-payments /opt/timora-payments/releases /opt/timora-payments/bin
install -d -m 0700 -o root -g root /etc/timora-payments
if [ ! -f /etc/timora-payments/env ]; then
  install -m 0600 -o root -g root "$ICI/payments.env.example" /etc/timora-payments/env
  echo "Fichier /etc/timora-payments/env cree (a remplir)."
fi
chmod 0600 /etc/timora-payments/env
install -m 0755 -o root -g root "$ICI/installer-version.sh" /opt/timora-payments/bin/installer-version.sh
install -m 0644 -o root -g root "$ICI/timora-payments.service" /etc/systemd/system/timora-payments.service
systemctl daemon-reload
systemctl enable timora-payments

etape "Caddy : HTTPS pour $DOMAINE"
sed -e "s/__DOMAINE__/$DOMAINE/g" -e "s/__EMAIL_ACME__/$EMAIL_ACME/g" "$ICI/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

etape "Pare-feu UFW : 80 et 443 publics, SSH limite"
ufw default deny incoming
ufw default allow outgoing
if [ -n "$IP_ADMIN" ]; then
  ufw allow from "$IP_ADMIN" to any port 22 proto tcp comment 'SSH administrateur'
else
  ufw limit 22/tcp comment 'SSH (limite)'
fi
ufw allow 80/tcp comment 'ACME + redirection HTTPS'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
ufw status verbose

etape "fail2ban (SSH)"
cat > /etc/fail2ban/jail.d/timora.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

etape "SSH : connexion par cle uniquement"
if [ "$ADMIN" = "root" ]; then
  CLES="/root/.ssh/authorized_keys"
  CONNEXION_ROOT="prohibit-password"
  echo "Conseil : creez un utilisateur sudo non-root (adduser, usermod -aG sudo) et relancez avec --admin <lui>."
else
  CLES="/home/$ADMIN/.ssh/authorized_keys"
  CONNEXION_ROOT="no"
fi
if id "$ADMIN" >/dev/null 2>&1 && [ -s "$CLES" ]; then
  cat > /etc/ssh/sshd_config.d/10-timora.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin $CONNEXION_ROOT
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl restart ssh
  echo "Mot de passe SSH desactive. GARDEZ cette session ouverte et testez une nouvelle connexion par cle avant de la fermer."
else
  echo "ATTENTION : aucune cle SSH pour $ADMIN ($CLES) : la connexion par mot de passe reste active."
  echo "Ajoutez votre cle publique (ssh-copy-id) puis relancez ce script."
fi

etape "Termine"
IPV4="$(curl -4 -fsS https://api.ipify.org || echo '?')"
cat <<EOF

IPv4 publique de ce serveur : $IPV4

Suite :
  1. DNS (chez votre registraire) : enregistrement A   $DOMAINE  ->  $IPV4
  2. Renseigner les variables : sudo nano /etc/timora-payments/env
  3. Depuis votre poste :        node services/payments/deploy/deployer.mjs $ADMIN@$IPV4
  4. JoonaPay : liste blanche $IPV4 ; webhook https://$DOMAINE/api/webhooks/joonapay
  5. Verification :              sudo bash -c 'cd /opt/timora-payments/current/services/payments && node --env-file=/etc/timora-payments/env scripts/diagnostic.mjs'
EOF
