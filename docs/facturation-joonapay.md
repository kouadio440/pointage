# Facturation Timora (JoonaPay)

Fiche d'exploitation : ce qu'il faut configurer, dans quel ordre, et comment
passer de la sandbox à la production.

## Parcours

```
Démonstration (sans compte) → « Activer mon entreprise » → compte → entreprise
(statut pending_payment) → formule → POST /api/billing/checkout → page JoonaPay
→ retour sur timora.tech → GET /api/billing/status (le serveur relit JoonaPay)
   ↘ webhook POST /api/webhooks/joonapay (signature vérifiée, puis relecture)
→ abonnement ACTIVE → premiers pas (zone, code, demandes) → premier pointage
```

Règle : **seul un état lu chez JoonaPay par le serveur** (`GET /payments/{uuid}`)
active un abonnement. Ni le navigateur, ni un webhook seul.

## Où vit quoi

| Élément | Emplacement |
|---|---|
| Tarifs (source unique) | table `platform_plans`, lue par `billing_plans_public()` |
| Mode sandbox / production | table `billing_settings` (une ligne) |
| Paiements | table `billing_payments` (référence `TIMORA-SUB-AAAAMMJJ-XXXXXXXX`) |
| Journal | table `billing_events` + journaux Vercel (JSON, sans secret) |
| Routes serveur | `api/billing/checkout.mjs`, `api/billing/status.mjs`, `api/webhooks/joonapay.mjs` |
| Logique serveur | `server/facturation/` (hors de `api/`, jamais exposé) |
| Écran d'activation | `apps/web/billing/activation.js` |
| Démonstration | `apps/web/demo/demo.js` |
| Migration / retour arrière | `services/supabase_migration_031_facturation.sql` / `..._retour.sql` |

## Variables d'environnement (Vercel, serveur uniquement)

| Variable | Valeur |
|---|---|
| `JOONAPAY_ENV` | `sandbox` (puis `production`) |
| `JOONAPAY_BASE_URL` | sandbox : `https://api.sandbox.wejoona.com/api/v1/developer` — production : `https://apis.joonapay.com/api/v1/developer` |
| `JOONAPAY_CLIENT_KEY` | clé client de la clé API |
| `JOONAPAY_PRIVATE_KEY` | clé privée (affichée une seule fois par JoonaPay) |
| `JOONAPAY_WEBHOOK_SECRET` | secret de signature des webhooks |
| `JOONAPAY_WEBHOOK_URL` | `https://www.timora.tech/api/webhooks/joonapay` |
| `JOONAPAY_DEFAULT_COUNTRY` | `CI` (facultatif) |
| `TIMORA_APP_URL` | `https://www.timora.tech` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | projet Supabase |

Sans elles, les routes répondent `503 PAIEMENT_NON_CONFIGURE` et le journal
indique **le nom** des variables manquantes (jamais leur valeur).

Garde-fous : sandbox pointant vers l'URL de production refusé ; webhook
`localhost` ou IP privée refusé ; mode du serveur différent de
`billing_settings.mode` → aucun paiement ne démarre.

## Ordre de mise en service

1. Renseigner les variables ci-dessus dans Vercel.
2. Déployer le code (front + routes `api/`).
3. Appliquer la migration 031 juste après (éditeur SQL de Supabase, ou
   `psql` avec la chaîne de connexion du projet).
   Entre 2 et 3, les tarifs affichent « Tarif indisponible » : aucun parcours
   n'est cassé. L'ordre inverse enverrait les nouvelles inscriptions vers un
   écran que l'ancien front ne connaît pas.
4. Sur le portail JoonaPay, déclarer le webhook
   `https://www.timora.tech/api/webhooks/joonapay`.
5. Vérifier : `node --env-file=.env scripts/joonapay-sandbox-check.mjs`
   (puis `--creer` pour un paiement de test de 100 XOF, annulé ensuite).

## Liste blanche d'adresses IP

JoonaPay n'accepte les appels que depuis les IP déclarées sur la clé API.
Les fonctions Vercel sortent par des **adresses variables** : sans IP fixe,
les appels à JoonaPay depuis `www.timora.tech` seront refusés (403), et
l'utilisateur verra « Le paiement en ligne est momentanément indisponible.
Aucun montant n'a été débité. »

Solutions (ne jamais déclarer une IP de téléphone, locale ou personnelle) :

- **Vercel Static IPs** (offre payante de Vercel) : déclarer les IP
  fournies par Vercel sur la clé JoonaPay.
- **Relais sortant** sur un serveur à IP fixe (VPS) qui ne transmet que vers
  l'hôte JoonaPay ; déclarer l'IP de ce serveur.
- Demander à JoonaPay si la liste blanche peut rester vide en sandbox.

L'IP `102.207.8.2` déclarée aujourd'hui est celle d'un poste de travail : elle
sert aux tests manuels depuis ce poste, pas au site en ligne.

## Qui peut payer en sandbox

Un paiement sandbox ne coûte rien : ouvert à tous, il permettrait d'utiliser
Timora sans payer. En mode `sandbox`, seuls les administrateurs de la
plateforme et les adresses déclarées peuvent lancer un paiement ; les autres
voient « Le paiement en ligne n'est pas encore ouvert ».

```sql
update public.billing_settings
   set testeurs_sandbox = array_append(testeurs_sandbox, 'testeur@exemple.ci');
```

## Tester la sandbox depuis le poste autorisé

Le poste dont l'IP est déclarée peut exécuter les routes localement :
`node --env-file=.env scripts/serve-web.mjs 8080`. JoonaPay exigeant des
adresses HTTPS, exposer ce serveur par un tunnel HTTPS et mettre l'adresse
du tunnel dans `TIMORA_APP_URL` et `JOONAPAY_WEBHOOK_URL`. Le panneau
« Diagnostic sandbox » apparaît alors sur la page de retour (en local
uniquement).

## Passage en production

1. Clé API **production** chez JoonaPay (après validation KYB), IP fixe déclarée.
2. Variables : `JOONAPAY_ENV=production`, URL, clés et secret de production.
3. En base : `update public.billing_settings set mode = 'production';`
4. Les entreprises créées pendant la sandbox sont des entreprises **de test** :
   un paiement de production ne les active pas. Pour celles qui n'ont jamais
   payé : `update public.companies set billing_environment = 'production'
   where billing_environment = 'sandbox' and status = 'pending_payment';`
5. Formule Entreprise (sur devis) : activation par la console super admin
   (`platform_set_subscription`).

## Retour arrière

`services/supabase_migration_031_facturation_retour.sql` restaure les
fonctions et politiques d'avant 031, sans supprimer aucune donnée
(historique des paiements conservé).
