# Facturation Timora (JoonaPay)

Fiche d'exploitation : ce qu'il faut configurer, dans quel ordre, et comment
passer de la sandbox à la production.

## Parcours

```
Démonstration (sans compte) → « Activer mon entreprise » → compte → entreprise
(statut pending_payment, abonnement PENDING_PAYMENT) → formule → récapitulatif
→ POST /api/billing/checkout → page JoonaPay
→ retour sur timora.tech → GET /api/billing/status (le serveur relit JoonaPay)
   ↘ webhook POST /api/webhooks/joonapay (signature vérifiée, puis relecture)
→ abonnement ACTIVE → premiers pas (zone, code, demandes) → premier pointage
```

Règle : **seul un état lu chez JoonaPay par le serveur** (`GET /payments/{uuid}`)
active un abonnement. Ni le navigateur, ni un webhook seul.

Tant que l'abonnement n'est pas `ACTIVE`, la base refuse avec le code
`SUBSCRIPTION_REQUIRED` : pointage, visage, borne QR, zones GPS, horaires,
adhésions, approbations, congés et heures supplémentaires.

## Où vit quoi

| Élément | Emplacement |
|---|---|
| Tarifs (source unique) | `apps/web/billing/catalogue.js` — affiché tel quel, recopié dans `platform_plans` par la migration 031, relu par le serveur de paiement |
| Mode sandbox / production, testeurs | table `billing_settings` (une ligne) |
| Paiements | table `billing_payments` (référence `TIMORA-SUB-AAAAMMJJ-XXXXXXXX`) |
| Journal | table `billing_events` + journaux Vercel (JSON, sans secret) |
| Routes serveur | `api/billing/checkout.mjs`, `api/billing/status.mjs`, `api/webhooks/joonapay.mjs` |
| Logique serveur | `server/facturation/` (hors de `api/`, jamais exposé) |
| Écran d'activation | `apps/web/billing/activation.js` |
| Avis des utilisateurs | table `reviews` (migration 032), `apps/web/avis/avis.js` |
| Démonstration | `apps/web/demo/demo.js` |
| Migrations / retours arrière | `services/supabase_migration_031_facturation*.sql`, `services/supabase_migration_032_avis*.sql` |

## Changer un prix

1. Modifier `apps/web/billing/catalogue.js`.
2. Porter le même montant dans `platform_plans` (migration).
3. `node scripts/check-billing-catalogue.mjs` (avec `--env-file=.env` pour
   comparer aussi la base en ligne) : il échoue si les deux diffèrent.

Tant qu'un écart existe, le serveur refuse les paiements de la formule
concernée (« Nos tarifs sont en cours de mise à jour ») plutôt que de facturer
un autre prix que celui affiché. La console super admin ne peut plus modifier
les prix des formules du catalogue.

## Variables d'environnement (Vercel, serveur uniquement)

| Variable | Valeur |
|---|---|
| `JOONAPAY_ENV` | `sandbox` (puis `production`) |
| `JOONAPAY_BASE_URL` | sandbox : `https://api-counter-demo.wejoona.com/api/v1/developer` — production : `https://apis.joonapay.com/api/v1/developer` (adresse affichée par le portail JoonaPay, suivie de `/v1/developer`) |
| `JOONAPAY_CLIENT_KEY` | clé client de la clé API |
| `JOONAPAY_PRIVATE_KEY` | clé privée (affichée une seule fois par JoonaPay) |
| `JOONAPAY_WEBHOOK_SECRET` | secret de signature des webhooks |
| `JOONAPAY_WEBHOOK_URL` | `https://www.timora.tech/api/webhooks/joonapay` |
| `JOONAPAY_DEFAULT_COUNTRY` | `CI` (facultatif) |
| `TIMORA_APP_URL` | `https://www.timora.tech` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | projet Supabase |

Sans elles, les routes répondent `503 PAIEMENT_NON_CONFIGURE` et le journal
indique **le nom** des variables manquantes (jamais leur valeur). Après tout
changement de variable, redéployer sur Vercel.

Garde-fous : en production, seul l'hôte `apis.joonapay.com` est accepté (un
paiement sandbox ne peut donc jamais activer un abonnement réel) ; en sandbox,
seuls les hôtes sandbox connus (`api-counter-demo.wejoona.com`,
`api.sandbox.wejoona.com`) ou un simulateur local : les clés ne partent vers
aucun autre serveur ; l'adresse doit se terminer par `/api/v1/developer` ;
webhook `localhost` ou IP privée refusé ; mode du serveur différent de
`billing_settings.mode` → aucun paiement ne démarre.

## Ordre de mise en service

1. Appliquer `services/supabase_migration_031_facturation.sql`, puis
   `services/supabase_migration_032_avis.sql` (éditeur SQL de Supabase :
   coller le fichier entier, exécuter). Chacune tourne dans une transaction.
2. Déployer le code (front + routes `api/`).
3. Renseigner les variables ci-dessus dans Vercel, puis redéployer.
4. Sur le portail JoonaPay, déclarer le webhook
   `https://www.timora.tech/api/webhooks/joonapay`.
5. Vérifier : `node --env-file=.env scripts/joonapay-sandbox-check.mjs`
   (puis `--creer` pour un paiement de test de 100 XOF, annulé ensuite).

## Liste blanche d'adresses IP

JoonaPay n'accepte les appels que depuis les IP déclarées sur la clé API.
Les fonctions Vercel sortent par des **adresses variables** : sans IP fixe,
les appels à JoonaPay depuis `www.timora.tech` seront refusés (HTTP 401,
message « IP address not authorized », code `IP_NON_AUTORISEE` dans nos
journaux), et
l'utilisateur verra « Le paiement en ligne est momentanément indisponible.
Aucun montant n'a été débité. »

Solutions (ne jamais déclarer une IP de téléphone, locale ou personnelle) :

- **Vercel Static IPs** (offre payante de Vercel) : déclarer les IP
  fournies par Vercel sur la clé JoonaPay.
- **Relais sortant** sur un serveur à IP fixe (VPS) qui ne transmet que vers
  l'hôte JoonaPay ; déclarer l'IP de ce serveur.
- Demander à JoonaPay si la liste blanche peut rester vide en sandbox.

L'IP `102.207.8.2` déclarée est celle d'un poste de travail, et elle change :
le 18/09 ce poste sortait par `102.210.17.34`. Une connexion Internet
d'entreprise ou domestique a rarement une IP fixe ; le script de vérification
affiche l'IP du moment.

**IPv6** : si la connexion dispose aussi d'IPv6, Node joint JoonaPay en IPv6 et
JoonaPay refuse l'appel même quand l'IPv4 est déclarée (constaté le 18/09).
Le script de vérification et le serveur local (`scripts/serve-web.mjs`)
forcent donc la sortie en IPv4.

## Clés sandbox et clés de production

Une clé appartient à UN environnement JoonaPay. Le portail JoonaPay ne crée
que des clés de **production** : son encadré « Environnement » (« Production
(ACTUEL) ») est informatif. D'après la documentation JoonaPay
(docs.joonapay.com/fr/introduction, section « Environnements »), les clés
sandbox sont distinctes : « demandez-les à votre contact Joonapay » (équipe
intégration : https://cal.com/joonapay-team/intro-call).

Deux adresses sandbox existent : `https://api-counter-demo.wejoona.com/api`
(affichée par le portail) et `https://api.sandbox.wejoona.com/api` (citée par
la documentation). Les routes marchand sont sous `/api/v1/developer` (vérifié :
`/misc` y exige les en-têtes `X-Client-Key` / `X-Private-Key`, toute autre
route répond 404). `scripts/joonapay-sandbox-check.mjs` essaie les deux et
indique celle qui reconnaît les clés.

Constaté les 18 et 19/09 : les trois paires de clés créées dans le portail sont
des clés de production (acceptées par `apis.joonapay.com`, « Invalid API
credentials » (HTTP 401) sur les deux adresses sandbox).

En sandbox, le résultat d'un paiement dépend du numéro de téléphone du payeur
(tableau par pays et opérateur : docs.joonapay.com/fr/guides/test-numbers ;
ex. Orange Côte d'Ivoire `+2250707000200` → SUCCESS).

## Qui peut payer en sandbox

Un paiement sandbox ne coûte rien : ouvert à tous, il permettrait d'utiliser
Timora sans payer. En mode `sandbox`, seuls les administrateurs de la
plateforme et les adresses déclarées peuvent lancer un paiement ; les autres
voient « Le paiement en ligne n'est pas encore ouvert ».

```sql
update public.billing_settings
   set testeurs_sandbox = array_append(testeurs_sandbox, 'testeur@exemple.ci');
```

## Tester la vraie sandbox depuis le poste autorisé

Le poste dont l'IP est déclarée chez JoonaPay peut exécuter les routes
localement, sans tunnel :

1. Ajouter dans `.env` les variables `JOONAPAY_*` (sandbox) et
   `TIMORA_APP_URL=` vide ; `JOONAPAY_WEBHOOK_URL` reste l'adresse publique.
2. `node --env-file=.env scripts/serve-web.mjs 8080`, puis ouvrir
   `http://localhost:8080`.
3. En local, les adresses de retour (non HTTPS) ne sont pas envoyées à
   JoonaPay : après le paiement, JoonaPay reste sur sa page. Revenir sur
   `http://localhost:8080` : l'écran d'activation vérifie automatiquement le
   paiement récent auprès du serveur, qui relit JoonaPay.
4. La console du navigateur et le terminal affichent les traces
   `[BILLING] …` (développement uniquement) ; l'écran d'activation porte un
   badge `SANDBOX` et, au retour, un panneau « Diagnostic sandbox ».

## Avis des utilisateurs

- Déposés par des comptes connectés (adresse vérifiée), un avis par compte.
- Publiés seulement après validation : console plateforme → onglet
  « ⭐ Avis » → Publier / Refuser.
- Note moyenne affichée à partir de 3 avis publiés ; mention « Client Timora »
  posée par le serveur (entreprise réelle en production), jamais saisie.

## Passage en production

1. Clé API **production** chez JoonaPay (après validation KYB), IP fixe déclarée.
2. Variables : `JOONAPAY_ENV=production`, URL, clés et secret de production.
3. En base : `update public.billing_settings set mode = 'production';`
4. Les entreprises créées pendant la sandbox sont des entreprises **de test** :
   un paiement de production ne les active pas. Pour celles qui n'ont jamais
   payé : `update public.companies set billing_environment = 'production'
   where billing_environment = 'sandbox' and status = 'pending_payment';` et
   `update public.company_subscriptions set environment = 'production'
   where status = 'PENDING_PAYMENT';`
5. Formule Entreprise (sur devis) : activation par la console super admin
   (`platform_set_subscription`).

## Retour arrière

`services/supabase_migration_032_avis_retour.sql` puis
`services/supabase_migration_031_facturation_retour.sql` restaurent l'état
d'avant, sans supprimer aucune donnée (paiements et avis conservés).
