#!/usr/bin/env bash
# =============================================================================
#  Mise en service d'une version du serveur de paiement (appele par deployer.mjs)
#    sudo /opt/timora-payments/bin/installer-version.sh /tmp/timora-payments-XXXX.tgz
#
#  Extraction dans releases/<date>, dependances exactes (npm ci, aucun script
#  d'installation), tests unitaires, bascule du lien « current », redemarrage,
#  controle de sante. Si la nouvelle version ne repond pas : retour
#  automatique a la precedente. Les 5 dernieres versions sont conservees.
# =============================================================================
set -euo pipefail

ARCHIVE="${1:-}"
[ -f "$ARCHIVE" ] || { echo "Archive introuvable : $ARCHIVE"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "A lancer en root (sudo)."; exit 1; }

BASE=/opt/timora-payments
VERSION="$(date -u +%Y%m%d%H%M%S)"
CIBLE="$BASE/releases/$VERSION"

install -d -m 0755 "$CIBLE"
tar -xzf "$ARCHIVE" -C "$CIBLE" --no-same-owner
chown -R root:root "$CIBLE"
chmod -R u=rwX,go=rX "$CIBLE"

cd "$CIBLE/services/payments"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --test "test/*.test.mjs"

# Version precedente : uniquement un lien deja en place qui pointe vers une
# VRAIE version. Sans cela, readlink -f renvoie le chemin du lien lui-meme et
# le retour arriere fabrique un lien circulaire (current -> current).
PRECEDENTE=""
if [ -L "$BASE/current" ]; then
  P="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  case "$P" in
    "$BASE"/releases/*) [ -d "$P" ] && PRECEDENTE="$P" ;;
  esac
fi
ln -sfn "$CIBLE" "$BASE/current.nouveau"
mv -Tf "$BASE/current.nouveau" "$BASE/current"
systemctl restart timora-payments

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "Version $VERSION en service."
    ls -1dt "$BASE"/releases/* | tail -n +6 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "La nouvelle version ne repond pas. Dernieres lignes du journal :"
journalctl -u timora-payments -n 30 --no-pager || true
if [ -n "$PRECEDENTE" ] && [ -d "$PRECEDENTE" ] && [ "$PRECEDENTE" != "$CIBLE" ]; then
  ln -sfn "$PRECEDENTE" "$BASE/current.nouveau"
  mv -Tf "$BASE/current.nouveau" "$BASE/current"
  systemctl restart timora-payments
  echo "Retour a la version precedente : $PRECEDENTE"
fi
exit 1
