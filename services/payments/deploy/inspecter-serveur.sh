#!/usr/bin/env bash
# =============================================================================
#  Inspection du serveur avant installation — LECTURE SEULE
# =============================================================================
#  Ne modifie RIEN. A lancer sur le serveur (console SSH Lightsail ou ssh) :
#
#    bash inspecter-serveur.sh
#
#  Affiche un rapport a recopier : systeme, versions, ce qui occupe 80/443,
#  pare-feu, SSH, ressources, et l'adresse IP de SORTIE du serveur (celle que
#  JoonaPay verra). Aucun secret n'est affiche.
# =============================================================================
titre() { printf '\n===== %s\n' "$1"; }
existe() { command -v "$1" >/dev/null 2>&1; }

titre "SYSTEME"
. /etc/os-release 2>/dev/null || true
echo "distribution : ${PRETTY_NAME:-inconnue} (${ID:-?} ${VERSION_ID:-?})"
echo "noyau        : $(uname -srm)"
echo "hote         : $(hostname)"
echo "duree        : $(uptime -p 2>/dev/null || uptime)"
echo "fuseau       : $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)"
echo "horloge NTP  : $(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
echo "init         : $(ps -p 1 -o comm= 2>/dev/null)"

titre "RESSOURCES"
free -h 2>/dev/null | sed -n '1,3p'
df -h / 2>/dev/null | sed -n '1,2p'
echo "processeurs  : $(nproc 2>/dev/null)"
echo "swap         : $(swapon --show=NAME,SIZE --noheadings 2>/dev/null | tr '\n' ' ')"

titre "UTILISATEURS"
echo "utilisateur courant : $(id -un) (uid $(id -u))"
echo "sudo sans mot de passe : $(sudo -n true 2>/dev/null && echo oui || echo 'non ou inconnu')"
for u in bitnami ubuntu admin debian ec2-user timora-pay; do
  id "$u" >/dev/null 2>&1 && echo "compte present : $u ($(getent passwd "$u" | cut -d: -f6,7))"
done
for u in bitnami ubuntu admin debian ec2-user root; do
  f="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)/.ssh/authorized_keys"
  [ -s "$f" ] && echo "cles SSH de $u : $(grep -c . "$f" 2>/dev/null) ligne(s)"
done

titre "NODE / NPM"
for c in node npm; do
  if existe "$c"; then echo "$c : $("$c" --version 2>&1) ($(command -v $c))"; else echo "$c : absent du PATH"; fi
done
[ -x /opt/bitnami/node/bin/node ] && echo "node Bitnami : $(/opt/bitnami/node/bin/node --version)"
if existe pm2; then
  echo "pm2 : $(pm2 --version 2>/dev/null)"
  echo "  applications relancees au demarrage par pm2 :"
  pm2 jlist 2>/dev/null | grep -o '"name":"[^"]*"' | sed 's/^/    /' || echo "    (liste illisible)"
  echo "  pm2-root.service : $(systemctl is-enabled pm2-root 2>/dev/null) / $(systemctl is-active pm2-root 2>/dev/null)"
fi

titre "PILE BITNAMI / SERVEURS WEB"
[ -d /opt/bitnami ] && echo "/opt/bitnami present : $(ls /opt/bitnami | tr '\n' ' ')" || echo "/opt/bitnami absent"
[ -x /opt/bitnami/ctlscript.sh ] && /opt/bitnami/ctlscript.sh status 2>/dev/null
for s in apache2 apache httpd nginx caddy bitnami mariadb mysql timora-payments; do
  systemctl list-unit-files 2>/dev/null | grep -q "^${s}\.service" && echo "service ${s} : $(systemctl is-enabled "$s" 2>/dev/null) / $(systemctl is-active "$s" 2>/dev/null)"
done

titre "PORTS EN ECOUTE"
if existe ss; then ss -lntup 2>/dev/null | sed -n '1,25p'; else netstat -lntup 2>/dev/null | sed -n '1,25p'; fi

titre "OCCUPANTS DE 80/443 ET LEUR MODE DE DEMARRAGE"
# Qui detient reellement les ports, sous quel compte, et qui le relance au boot.
PIDS="$( (ss -lntp 2>/dev/null || true) | awk '$4 ~ /:(80|443)$/ {print}' \
  | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u )"
if [ -z "$PIDS" ]; then
  echo "80/443 libres."
else
  for p in $PIDS; do
    echo "--- PID $p"
    ps -o pid,ppid,user,lstart,cmd -p "$p" --no-headers 2>/dev/null
    echo "unite systemd : $(ps -o unit= -p "$p" 2>/dev/null | tr -d ' ')"
    echo "repertoire    : $(readlink -f /proc/$p/cwd 2>/dev/null)"
    echo "binaire       : $(readlink -f /proc/$p/exe 2>/dev/null)"
    # Un processus non-root sur 80/443 a forcement une capacite : la reperer.
    EXE="$(readlink -f /proc/$p/exe 2>/dev/null)"
    [ -n "$EXE" ] && existe getcap && echo "capacites     : $(getcap "$EXE" 2>/dev/null || echo aucune)"
    # Le chemin du script sert a chercher qui le relance.
    CIBLE="$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -o '/[^ ]*\.js' | head -1)"
    [ -n "$CIBLE" ] && echo "script        : $CIBLE"
    if [ -n "$CIBLE" ]; then
      NOM="$(basename "$(dirname "$CIBLE")")"
      echo "relance au demarrage : references a « $NOM » —"
      # cloud-init : per-boot rejoue A CHAQUE demarrage, per-instance une seule fois.
      for d in /var/lib/cloud/scripts/per-boot /var/lib/cloud/scripts/per-instance \
               /var/lib/cloud/scripts/per-once /etc/systemd/system /etc/cron.d; do
        [ -d "$d" ] && grep -rl "$NOM" "$d" 2>/dev/null | sed "s/^/  /"
      done
      grep -l "$NOM" /etc/rc.local 2>/dev/null | sed 's/^/  /'
      # PM2 : la liste des applications est dans dump.pm2, jamais dans l'unite
      # systemd — une recherche dans /etc/systemd ne trouve donc rien.
      [ -f /root/.pm2/dump.pm2 ] && grep -qs "$NOM" /root/.pm2/dump.pm2 \
        && echo "  /root/.pm2/dump.pm2 (relance par pm2-root.service)"
      crontab -l 2>/dev/null | grep -n "$NOM" | sed 's/^/  crontab: /'
      # user-data peut contenir des secrets : on n'affiche que les lignes utiles.
      [ -f /var/lib/cloud/instance/user-data.txt ] \
        && grep -n "$NOM" /var/lib/cloud/instance/user-data.txt 2>/dev/null | head -5 | sed 's/^/  user-data: /'
    fi
  done
fi
echo "cloud-init : $(cloud-init status 2>/dev/null | head -1)"
echo "demarre le : $(uptime -s 2>/dev/null)   (si egal a la creation, la machine n'a jamais redemarre)"
ls -1 /var/lib/cloud/scripts/per-boot/ 2>/dev/null | sed 's/^/per-boot: /' || true

titre "PARE-FEU LOCAL"
existe ufw && ufw status verbose 2>/dev/null | sed -n '1,12p' || echo "ufw absent"
existe iptables && echo "regles iptables (filter) : $(iptables -S 2>/dev/null | wc -l)"
existe fail2ban-client && echo "fail2ban : $(fail2ban-client status 2>/dev/null | tr '\n' ' ')" || echo "fail2ban absent"

titre "SSH"
grep -hiE '^\s*(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication|Port)\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sort -u

titre "SORTIE INTERNET (aucune donnee envoyee, aucun paiement)"
IP4="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '?')"
echo "IPv4 publique de sortie : $IP4   (doit etre l'IP statique declaree chez JoonaPay)"
echo -n "JoonaPay (sans cle, 401 attendu) : "
curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 10 https://apis.joonapay.com/api/v1/developer/misc 2>/dev/null || echo injoignable
echo -n "Supabase (page publique)         : "
curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 10 https://supabase.com/robots.txt 2>/dev/null || echo injoignable

titre "FIN"
echo "Rien n'a ete modifie."
