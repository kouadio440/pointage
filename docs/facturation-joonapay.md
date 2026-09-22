# Facturation Timora (JoonaPay) — exploitation

Ce qu'il faut configurer, dans quel ordre, pour encaisser en production, et
comment valider la chaîne avec un unique paiement contrôlé de 100 XOF.

## Architecture

```
Navigateur ──► www.timora.tech (Vercel) ──requête signée (HMAC)──► payments.timora.tech ──► JoonaPay (production)
                  /api/billing/checkout                               serveur Linux à IPv4 FIXE
                  /api/billing/status                                  (liste blanche JoonaPay)
                                                                            │
JoonaPay ──webhook signé──► payments.timora.tech/api/webhooks/joonapay ─────┴──► Supabase (clé de service)
```

- **Le navigateur** n'envoie qu'une formule et une période ; il ne voit
  aucune clé et n'appelle jamais le serveur de paiement.
- **Vercel** relaie, signé (`INTERNAL_PAYMENT_API_SECRET`) ; il ne détient
  aucune clé JoonaPay ni la clé de service Supabase.
- **Le serveur de paiement** (`services/payments/`) est la seule passerelle
  JoonaPay : création du paiement, relecture de l'état, webhook (HMAC JoonaPay,
  anti-rejeu), activation, reçu PDF, e-mail, journal. Détail :
  `services/payments/LISEZMOI.md`.

Règle : **seul un état lu chez JoonaPay par le serveur** (`SUCCESS` + `PAID`,
montant, devise et référence exacts) active un abonnement — jamais un webhook
seul, jamais un retour de navigateur.

## Parcours client

```
Démonstration (sans compte) → « Activer mon entreprise » → compte → entreprise
(pending_payment) → formule → récapitulatif → paiement JoonaPay → retour
(« Vérification de votre paiement… ») ↔ webhook → abonnement ACTIVE, entreprise
active → reçu + e-mail de bienvenue → premiers pas → premier pointage.
```

Webhook et retour navigateur mènent à la même fonction atomique et
idempotente : le premier qui constate le paiement active, le second ne fait
rien de plus (un abonnement, un reçu, un e-mail).

## Où vit quoi

| Élément | Emplacement |
|---|---|
| Tarifs et limites (source unique) | `apps/web/billing/catalogue.js` → `platform_plans` (migrations 031 et 033) ; `node scripts/check-billing-catalogue.mjs` vérifie la concordance |
| Serveur de paiement | `services/payments/` (routes, reçus, e-mail, tâches, déploiement) |
| Logique de facturation | `server/facturation/` ; signature interne : `server/passerelle/` |
| Relais Vercel | `api/billing/checkout.mjs`, `api/billing/status.mjs`, `api/webhooks/joonapay.mjs` (ancienne adresse de webhook, relayée) |
| Écran d'activation, facturation du cockpit | `apps/web/billing/activation.js`, `apps/web/billing/cockpit-facturation.js` |
| Paiements, reçus, journal | tables `billing_payments`, `billing_receipts`, `billing_events` (ajout seul) |
| Test de production | table `billing_smoke_test` (usage unique) |
| Migrations / retours arrière | `services/supabase_migration_03{1,2,3}_*.sql` et leurs `_retour.sql` |

## Limites par formule (contrôlées par la base)

| Formule | Collaborateurs | Sites | Administrateurs |
|---|---|---|---|
| Essentiel — 15 000 XOF/mois | 10 | 1 | 1 |
| Business — 35 000 XOF/mois | 30 | 3 | 3 |
| Pro — 75 000 XOF/mois | 100 | 10 | 10 |
| Entreprise — sur devis | contrat | contrat | contrat |

- **Collaborateurs** : rattachements ACTIFS de rôle employé ou manager. Les
  demandes en attente ne comptent pas (plafonnées à 2 × la limite, 20 au
  moins, contre le spam).
- **Administrateurs** : propriétaire COMPRIS, plus les administrateurs.
- **Sites** : zones de pointage actives.
- Au-delà : la base refuse (`PLAN_EMPLOYEE_LIMIT_REACHED`,
  `PLAN_SITE_LIMIT_REACHED`, `PLAN_ADMIN_LIMIT_REACHED`) ; le cockpit affiche
  « Vous avez atteint la limite de votre formule. » et « Changer de formule ».
- Formule supérieure : achetable à tout moment, appliquée au paiement, la
  période en cours est prolongée. Formule inférieure ou renouvellement : 7 jours
  avant l'échéance, et refusée si l'usage la dépasse (`PLAN_DOWNGRADE_BLOCKED`).
  Aucun collaborateur n'est jamais retiré automatiquement.
- Formule Entreprise : limites posées sur l'abonnement (colonnes `seats`,
  `max_sites`, `max_admins` de `company_subscriptions`).
- Expiration : l'abonnement passe `EXPIRED` (tâche du serveur, toutes les
  15 min), les fonctions payantes se ferment, le propriétaire est dirigé vers le
  renouvellement. Rien n'est supprimé.

## Le serveur de production

| | |
|---|---|
| Hébergeur | AWS Lightsail (région `eu-west-3`, Paris) |
| IPv4 fixe | **15.236.1.218** — c'est elle qui est déclarée chez JoonaPay |
| Nom | `payments.timora.tech` (enregistrement A → 15.236.1.218) |
| Pare-feu Lightsail | 22 (SSH, restreint à l'IP d'administration), 80, 443 |
| Ports ouverts sur Internet | 80 et 443 seulement ; Node écoute sur `127.0.0.1:3000` |

L'image de départ n'est **pas** un Ubuntu vierge : lancer d'abord
`bash inspecter-serveur.sh` (lecture seule) et adapter. L'installateur détecte
la distribution et ce qui occupe déjà 80/443.

## Mise en production — dans cet ordre

1. **Sauvegarde, puis nettoyage des comptes de test** (voir plus bas).
2. **Serveur** : copier `services/payments/deploy/` sur le serveur, lancer
   `bash inspecter-serveur.sh` (ne modifie rien), puis
   `sudo bash installer-serveur.sh --email-acme <email> --admin <utilisateur> [--ip-admin <IPv4>] [--liberer-web]`.
   `--liberer-web` arrête la pile web préinstallée (Apache/Nginx/Bitnami) qui
   occupe 80/443 ; sans elle, l'installateur s'arrête et le dit.
3. **DNS** : enregistrement A `payments.timora.tech` → **15.236.1.218**. Si le
   domaine a un joker `*.timora.tech` vers Vercel, l'enregistrement A du
   sous-domaine doit exister explicitement pour le supplanter.
4. **JoonaPay (portail)** : générer de **nouvelles clés de production** (les
   précédentes ont été exposées : les révoquer) ; liste blanche =
   **15.236.1.218** ; webhook = `https://payments.timora.tech/api/webhooks/joonapay`.
5. **Messagerie** : un fournisseur SMTP (domaine `timora.tech` vérifié : SPF,
   DKIM). Le même SMTP se règle dans Supabase Auth (fin de la limite de
   2 e-mails par heure des codes de connexion).
6. **Serveur** : remplir `/etc/timora-payments/env`
   (modèle `payments.env.example`), puis depuis le poste :
   `node services/payments/deploy/deployer.mjs <utilisateur>@15.236.1.218` ;
   vérifier avec `scripts/diagnostic.mjs`, puis depuis le poste
   `node scripts/verifier-serveur-paiement.mjs` (aucun paiement créé).
7. **Supabase (éditeur SQL)** : appliquer `supabase_migration_033_paiement_production.sql`,
   puis passer en production : `update public.billing_settings set mode = 'production';`
8. **Vercel** : `PAYMENT_SERVER_URL=https://payments.timora.tech`,
   `INTERNAL_PAYMENT_API_SECRET` (même valeur que le serveur),
   `TIMORA_APP_URL=https://www.timora.tech` ; retirer toute variable
   `JOONAPAY_*` ou `SUPABASE_SERVICE_ROLE_KEY` de Vercel ; déployer.
9. **Test unique à 100 XOF** (ci-dessous), puis désactivation.
10. **JoonaPay** : retirer de la liste blanche les IP temporaires (postes
    personnels) ; seule l'IP du serveur reste. Retirer les clés JoonaPay du
    `.env` du poste.

## Test de production unique (100 XOF)

Ce n'est pas un prix : la page d'accueil, le catalogue et le checkout normal
restent à 15 000 XOF. Le montant de 100 XOF n'est appliqué que si **toutes**
les conditions sont vraies : `PRODUCTION_SMOKE_TEST_ENABLED=true` sur le
serveur ; test activé en base pour l'empreinte SHA-256 du compte (l'adresse
n'est jamais stockée) ; mode production ; entreprise de ce compte en attente de
paiement ; Essentiel mensuel ; test jamais consommé. Sinon : tarif normal.

1. Créer le compte et l'entreprise de test sur www.timora.tech (s'arrêter à
   l'écran « Votre espace Timora est presque prêt. »).
2. Sur le serveur : `scripts/test-production.mjs activer <adresse du compte>`,
   puis `PRODUCTION_SMOKE_TEST_ENABLED=true` (et l'empreinte affichée dans
   `PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH`), `sudo systemctl restart timora-payments`.
3. Sur le site : Essentiel, mensuel → la redirection annonce « Test de
   production contrôlé : 100 FCFA » ; JoonaPay affiche 100 XOF ; payer.
4. Vérifier : « Bienvenue sur Timora », reçu `TIM-REC-…` (onglet
   Facturation), e-mail reçu, `scripts/test-production.mjs etat` → consommé.
5. Remettre `PRODUCTION_SMOKE_TEST_ENABLED=false`, redémarrer,
   `scripts/test-production.mjs desactiver`.
6. Avec un autre compte : Essentiel doit demander 15 000 XOF (ne pas payer).

Une fois consommé, le test ne se réactive plus (la base le refuse, même en SQL
direct). Un second paiement de test éventuel serait encaissé, tracé
(`DUPLICATE_PAYMENT`) et reçu émis, sans nouvelle activation.

## Sauvegarde et nettoyage des comptes de test

Sauvegarde (hors Git, avec les fichiers du stockage et un `MANIFEST.json`
d'empreintes) : `sauvegardes-timora/<date>/`. Nettoyage : supprime les
entreprises, adhésions, abonnements, pointages, visages, zones, horaires,
congés, heures supplémentaires, événements d'authentification, fichiers du
stockage et comptes Auth (API d'administration officielle), **sauf** les
administrateurs de la plateforme. Il refuse de s'exécuter si la sauvegarde est
absente ou altérée, ou si un paiement est enregistré.

## Reçus et e-mails

- Reçu « Reçu de paiement Timora » (pas « facture » : les mentions légales ne
  sont pas toutes disponibles), numéro `TIM-REC-AAAA-NNNNNN` sans trou, émis
  dans la transaction d'activation ; PDF dans le bucket **privé**
  `billing-receipts/<entreprise>/<numéro>.pdf` ; téléchargement par lien signé
  de 60 s, pour le propriétaire et les administrateurs de l'entreprise.
- Mentions de l'éditeur (`TIMORA_LEGAL_*`) affichées seulement si renseignées.
- E-mail avec le PDF joint ; un échec n'annule rien : nouvel essai 2, 4, 8…
  minutes (8 essais), suivi dans `billing_receipts.email_status`.

## Journal et alertes

- `billing_events` (ajout seul) : `PAYMENT_CREATED`, `JOONAPAY_PAYMENT_CREATED`,
  `WEBHOOK_VERIFIED`, `PAYMENT_PROVIDER_CONFIRMED`, `SUBSCRIPTION_ACTIVATED`,
  `SUBSCRIPTION_EXPIRED`, `INVOICE_CREATED`, `INVOICE_EMAIL_SENT` /
  `INVOICE_EMAIL_FAILED`, `PAYMENT_FAILED`, `SMOKE_TEST_*`, et les alertes
  `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `UNKNOWN_PAYMENT`,
  `DUPLICATE_PAYMENT`, `ACTIVATION_FAILED`.
- Serveur : `journalctl -u timora-payments` (JSON, jamais de secret) ; alertes :
  `journalctl -u timora-payments -p err`.

## Retour arrière

`supabase_migration_033_paiement_production_retour.sql` rétablit la 031
(fonctions et droits) sans supprimer aucune donnée ; les protections des
traces financières restent. Puis 032 et 031 comme avant, si nécessaire.
