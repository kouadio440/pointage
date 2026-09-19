# Serveur de paiement Timora — `payments.timora.tech`

Seule passerelle de Timora vers JoonaPay. Il tourne sur un petit serveur Linux
à **IPv4 fixe** (déclarée dans la liste blanche JoonaPay) et détient seul les
clés JoonaPay de production et la clé de service Supabase.

```
Navigateur ──► www.timora.tech (Vercel) ──signature HMAC──► payments.timora.tech ──► JoonaPay (production)
                                                                   │
JoonaPay ──webhook signé (HMAC JoonaPay)──────────────────────────►│──► Supabase (clé de service)
```

Le navigateur n'appelle jamais ce serveur et ne voit aucun secret. Vercel ne
détient aucune clé JoonaPay ni la clé de service Supabase : il relaie, signé.

## Routes

| Route | Accès | Rôle |
|---|---|---|
| `GET /health` | public | `{"status":"ok"}`, sans détail |
| `POST /api/payments/checkout` | signature interne + session | crée le paiement (formule et période seulement ; tout montant envoyé est ignoré) |
| `GET /api/payments/:reference/status` | signature interne + session | état du paiement (relu chez JoonaPay s'il est en attente) ; « introuvable » pour une autre entreprise |
| `POST /api/webhooks/joonapay` | signature JoonaPay | notification : signature vérifiée sur le corps brut, anti-rejeu, puis relecture du paiement chez JoonaPay |

Toute autre route : 404. Aucun en-tête CORS. En-têtes de sécurité sur chaque
réponse (HSTS, `nosniff`, CSP `default-src 'none'`, `no-store`…).

## Signature interne (Vercel → serveur de paiement)

En-têtes `X-Timora-Timestamp`, `X-Timora-Nonce`, `X-Timora-Signature: v1=<hex>`
et `X-Timora-User-Token` (jeton de session de l'acheteur).

```
HMAC-SHA256( "v1\nMÉTHODE\nCHEMIN?REQUÊTE\nHORODATAGE\nNONCE\nSHA256(jeton)\nCORPS_BRUT",
             INTERNAL_PAYMENT_API_SECRET )
```

Refusé (401) : signature fausse (comparaison à temps constant), horodatage à
plus de 5 minutes, nonce déjà vu, requête signée avant le démarrage du
serveur, jeton remplacé. Le jeton est ensuite vérifié auprès de Supabase Auth.
Code : `server/passerelle/signature.mjs`.

## Règles financières

- Montant décidé par la base (`billing_prepare_checkout_v2`) ET recalculé ici
  depuis le catalogue (`apps/web/billing/catalogue.js`) ; tout écart bloque le
  paiement.
- Activation seulement sur un état **lu chez JoonaPay** (`SUCCESS` + `PAID`,
  montant et devise exacts, référence Timora exacte) — jamais sur la foi d'un
  webhook ou d'un retour de navigateur. Webhook et retour navigateur mènent à
  la même fonction, atomique et idempotente (`billing_apply_provider_status`).
- Un reçu `TIM-REC-AAAA-NNNNNN` est émis dans la même transaction que
  l'activation ; le PDF est déposé dans le bucket privé `billing-receipts`,
  puis envoyé par e-mail (nouvel essai 2, 4, 8… min en cas d'échec, sans
  jamais toucher au paiement).
- Tâches périodiques : reçus et e-mails (1 min), rapprochement des paiements
  en attente (5 min), expiration des abonnements (15 min).

## Test de production unique (100 XOF)

Jamais un prix : le catalogue et le checkout normal restent à 15 000 XOF.
Appliqué seulement si **toutes** les conditions sont vraies : variable
`PRODUCTION_SMOKE_TEST_ENABLED=true` sur ce serveur, test activé en base pour
l'empreinte SHA-256 du compte, mode production, entreprise en attente de
paiement, Essentiel mensuel, test jamais consommé. Consommé et désactivé
dans la transaction d'activation ; il ne se réactive plus (la base le refuse).

```
sudo bash -c 'cd /opt/timora-payments/current/services/payments && node --env-file=/etc/timora-payments/env scripts/test-production.mjs activer <adresse>'
sudo bash -c 'cd /opt/timora-payments/current/services/payments && node --env-file=/etc/timora-payments/env scripts/test-production.mjs etat'
sudo bash -c 'cd /opt/timora-payments/current/services/payments && node --env-file=/etc/timora-payments/env scripts/test-production.mjs desactiver'
```

## Installation (Ubuntu 24.04 LTS, 1 vCPU, 1–2 Go de RAM, IPv4 fixe)

1. Copier `deploy/` sur le serveur, puis :
   `sudo bash installer-serveur.sh --email-acme vous@exemple.com --admin <utilisateur> [--ip-admin <IPv4>]`
2. DNS : enregistrement **A** `payments.timora.tech` → IPv4 du serveur.
3. Remplir `/etc/timora-payments/env` (modèle : `deploy/payments.env.example`).
4. Depuis le poste : `node services/payments/deploy/deployer.mjs <utilisateur>@<IPv4>`.
5. Vérifier : `scripts/diagnostic.mjs` (voir ci-dessus pour la commande).

## Exploitation

- Journaux (JSON, sans secret) : `journalctl -u timora-payments -f`.
  Alertes : `journalctl -u timora-payments -p err` (niveau `ALERTE` :
  `WEBHOOK_SIGNATURE_INVALID`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`,
  `UNKNOWN_PAYMENT`, `DUPLICATE_PAYMENT`, `ACTIVATION_FAILED`,
  `SUPABASE_WRITE_FAILED`, `JOONAPAY_UNAVAILABLE`, `INTERNAL_SIGNATURE_REJECTED`).
- Redémarrer : `sudo systemctl restart timora-payments`.
- Tests unitaires : `npm test` (dans ce dossier).
- Rotation d'un secret : modifier `/etc/timora-payments/env` (et Vercel pour
  `INTERNAL_PAYMENT_API_SECRET`), puis redémarrer.
