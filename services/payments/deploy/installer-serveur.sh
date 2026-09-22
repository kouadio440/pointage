#!/usr/bin/env bash
# =============================================================================
#  Serveur de paiement Timora — installation et durcissement
#  (Debian 11/12 — y compris les images Bitnami d'AWS Lightsail — ou Ubuntu 22.04/24.04)
# =============================================================================
#  A lancer UNE fois, en root, depuis ce dossier copie sur le serveur :
#
#    sudo bash installer-serveur.sh --email-acme vous@exemple.com \
#         [--admin <utilisateur>] [--domaine payments.timora.tech] \
#         [--ip-admin <IPv4 d'administration>] [--liberer-web] [--sans-ufw] [--sans-ssh]
#
#  Installe : mises a jour de securite automatiques, Node.js LTS et Caddy
#  (depots officiels signes), utilisateur de service sans shell, service
#  systemd durci (redemarrage automatique), HTTPS Let's Encrypt, pare-feu UFW
#  (80/443 publics, SSH limite), fail2ban, journaux bornes, SSH par cle
#  seulement (uniquement si une cle fonctionne deja).
#
#  --liberer-web : arrete et desactive ce qui occupe deja 80/443 (Apache, Nginx
#  ou pile Bitnami de l'image Lightsail) pour laisser la place a Caddy.
#
#  Aucune base de donnees n'est installee ni exposee. Rejouable sans risque.
#  Inspecter AVANT : bash inspecter-serveur.sh
# =============================================================================
set -euo pipefail

DOMAINE="payments.timora.tech"
EMAIL_ACME=""
ADMIN=""
IP_ADMIN=""
FUSEAU="Africa/Abidjan"
LIBERER_WEB=0
SANS_UFW=0
SANS_SSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domaine) DOMAINE="$2"; shift 2 ;;
    --email-acme) EMAIL_ACME="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --ip-admin) IP_ADMIN="$2"; shift 2 ;;
    --fuseau) FUSEAU="$2"; shift 2 ;;
    --liberer-web) LIBERER_WEB=1; shift ;;
    --sans-ufw) SANS_UFW=1; shift ;;
    --sans-ssh) SANS_SSH=1; shift ;;
    *) echo "Option inconnue : $1"; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "A lancer en root : sudo bash $0 ..."; exit 1; }
[ -n "$EMAIL_ACME" ] || { echo "Usage : sudo bash $0 --email-acme vous@exemple.com [--admin <utilisateur>] [--liberer-web]"; exit 1; }
echo "$DOMAINE" | grep -Eq '^[a-z0-9.-]+\.[a-z]{2,}$' || { echo "Domaine invalide : $DOMAINE"; exit 1; }

. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:*|debian:*|*:*debian*) : ;;
  *) echo "Systeme non pris en charge (${PRETTY_NAME:-inconnu}) : ce script attend Debian ou Ubuntu."; exit 1 ;;
esac
DEPOT_NODE="nodistro"   # depot NodeSource commun a Debian et Ubuntu

# Utilisateur d'administration : celui indique, sinon celui de l'image.
if [ -z "$ADMIN" ]; then
  for u in bitnami ubuntu admin debian; do id "$u" >/dev/null 2>&1 && { ADMIN="$u"; break; }; done
fi
ICI="$(cd "$(dirname "$0")" && pwd)"
etape() { printf '\n==> %s\n' "$1"; }
echo "Systeme : ${PRETTY_NAME:-?} | administrateur : ${ADMIN:-inconnu} | domaine : $DOMAINE"

# -----------------------------------------------------------------------------
etape "Ports 80 et 443 : qui les occupe ?"
OCCUPANTS="$( (ss -lntp 2>/dev/null || true) | awk '$4 ~ /:(80|443)$/ {print}' )"
if [ -n "$OCCUPANTS" ] && ! echo "$OCCUPANTS" | grep -q caddy; then
  echo "$OCCUPANTS"
  if [ "$LIBERER_WEB" -eq 1 ]; then
    echo "Liberation demandee : arret de la pile web existante."
    [ -x /opt/bitnami/ctlscript.sh ] && /opt/bitnami/ctlscript.sh stop || true
    # PM2 relance ses applications a chaque demarrage depuis /root/.pm2/dump.pm2 :
    # l'unite systemd ne cite aucun nom d'application, d'ou des recherches vaines.
    if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q online; then
      echo "PM2 gere des applications : elles seront retirees de son demarrage automatique."
      cp -a /root/.pm2/dump.pm2 /root/.pm2/dump.pm2.avant-timora 2>/dev/null || true
      pm2 delete all 2>/dev/null || true
      pm2 save --force 2>/dev/null || true
    fi
    for s in bitnami apache2 apache httpd nginx lighttpd; do
      systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service" && systemctl disable --now "$s" 2>/dev/null || true
    done
    sleep 2
    RESTE="$( (ss -lntp 2>/dev/null || true) | awk '$4 ~ /:(80|443)$/ {print}' )"
    if [ -n "$RESTE" ] && ! echo "$RESTE" | grep -q caddy; then
      echo "Ports toujours occupes :"; echo "$RESTE"
      echo "Arretez ce service a la main, puis relancez ce script."; exit 1
    fi
  else
    cat <<EOF

Les ports 80 et/ou 443 sont deja pris (image Lightsail « Node.js » : pile
Bitnami). Caddy ne pourra pas obtenir le certificat.
Relancez avec --liberer-web pour arreter et desactiver cette pile,
ou arretez-la vous-meme puis relancez ce script.
EOF
    exit 1
  fi
else
  echo "80/443 libres (ou deja servis par Caddy)."
fi

# -----------------------------------------------------------------------------
etape "Mises a jour du systeme"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl gnupg fail2ban unattended-upgrades \
  apt-transport-https debian-keyring debian-archive-keyring
[ "$SANS_UFW" -eq 1 ] || apt-get -y -q install ufw

etape "Mises a jour de securite automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

etape "Horloge et fuseau ($FUSEAU)"
timedatectl set-ntp true 2>/dev/null || true
timedatectl set-timezone "$FUSEAU" 2>/dev/null || true

etape "Journaux bornes (200 Mo au plus, persistants)"
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/timora.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
MaxRetentionSec=1month
EOF
systemctl restart systemd-journald || true

etape "Node.js LTS"
VERSION_NODE="$(/usr/bin/node --version 2>/dev/null | tr -d 'v' | cut -d. -f1 || echo 0)"
if [ "${VERSION_NODE:-0}" -ge 22 ] 2>/dev/null; then
  echo "Node systeme deja present : $(/usr/bin/node --version)"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x $DEPOT_NODE main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get -y -q install nodejs
  echo "Node installe : $(/usr/bin/node --version)"
fi

etape "Caddy (depot officiel signe)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get -y -q install caddy
fi
caddy version

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
systemctl restart caddy

if [ "$SANS_UFW" -eq 0 ]; then
  etape "Pare-feu local UFW (le pare-feu Lightsail reste la premiere barriere)"
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  if [ -n "$IP_ADMIN" ]; then
    ufw allow from "$IP_ADMIN" to any port 22 proto tcp comment 'SSH administrateur'
    # La console SSH du navigateur Lightsail vient d'autres adresses : on garde
    # un acces limite pour ne pas se couper du serveur.
    ufw limit 22/tcp comment 'SSH (limite, console Lightsail)'
  else
    ufw limit 22/tcp comment 'SSH (limite)'
  fi
  ufw allow 80/tcp comment 'ACME + redirection HTTPS'
  ufw allow 443/tcp comment 'HTTPS'
  ufw --force enable
  ufw status verbose
fi

etape "fail2ban (SSH)"
# Debian 12 n'ecrit plus /var/log/auth.log : sans backend systemd, fail2ban
# echoue au demarrage (« Have not found any log file for sshd jail »).
apt-get -y -q install python3-systemd >/dev/null 2>&1 || true
cat > /etc/fail2ban/jail.d/timora.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

if [ "$SANS_SSH" -eq 0 ]; then
  etape "SSH : connexion par cle uniquement"
  CLES=""
  [ -n "$ADMIN" ] && CLES="$(getent passwd "$ADMIN" | cut -d: -f6)/.ssh/authorized_keys"
  if [ -n "$ADMIN" ] && [ -s "$CLES" ]; then
    cat > /etc/ssh/sshd_config.d/10-timora.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
EOF
    sshd -t
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh
    echo "Mot de passe SSH desactive (cle deja en place pour $ADMIN)."
    echo "GARDEZ cette session ouverte et testez une NOUVELLE connexion par cle avant de la fermer."
  else
    echo "Aucune cle SSH trouvee pour l'administrateur (${ADMIN:-inconnu}) : rien n'est durci ici."
    echo "Ajoutez votre cle publique dans ~/.ssh/authorized_keys, puis relancez ce script."
  fi
fi

etape "Termine"
IPV4="$(curl -4 -fsS --max-time 8 https://api.ipify.org || echo '?')"
cat <<EOF

IPv4 publique de SORTIE de ce serveur : $IPV4
(c'est l'adresse que JoonaPay verra : elle doit etre dans sa liste blanche)

Suite :
  1. DNS : enregistrement A  $DOMAINE  ->  $IPV4
  2. Variables : sudo nano /etc/timora-payments/env
  3. Depuis votre poste : node services/payments/deploy/deployer.mjs $ADMIN@$IPV4
  4. JoonaPay : liste blanche $IPV4 ; webhook https://$DOMAINE/api/webhooks/joonapay
  5. Verification : sudo bash -c 'cd /opt/timora-payments/current/services/payments && node --env-file=/etc/timora-payments/env scripts/diagnostic.mjs'
  6. Etat du service : systemctl status timora-payments ; journalctl -u timora-payments -f
EOF
