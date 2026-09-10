-- =============================================================================
--  MIGRATION 019 — Verrouillage des tables de facturation
-- =============================================================================
--
--  Les cinq tables creees en 017 ont bien la RLS active et aucune politique :
--  une requete anonyme repart donc les mains vides. Mais elle repart avec un
--  200, pas un refus — parce que Supabase accorde par defaut SELECT, INSERT,
--  UPDATE et DELETE aux roles `anon` et `authenticated` sur toute nouvelle
--  table du schema public. Seule la RLS retient les lignes.
--
--  C'est une securite a un seul cran. Le jour ou quelqu'un ajoute une
--  politique permissive sur `platform_payments` — le projet en compte deja
--  plusieurs en `USING (true)` sur `companies`, `users` et
--  `company_memberships` — la table s'ouvrirait d'un coup, en lecture comme
--  en ecriture.
--
--  On retire donc les privileges eux-memes. Les fonctions SECURITY DEFINER
--  ne sont pas concernees : elles s'executent avec les droits du proprietaire,
--  et restent le seul chemin d'acces.
-- =============================================================================

BEGIN;

REVOKE ALL ON public.platform_admins        FROM anon, authenticated;
REVOKE ALL ON public.platform_plans         FROM anon, authenticated;
REVOKE ALL ON public.company_subscriptions  FROM anon, authenticated;
REVOKE ALL ON public.platform_invoices      FROM anon, authenticated;
REVOKE ALL ON public.platform_payments      FROM anon, authenticated;

-- Les fonctions de la plateforme ne doivent pas etre appelables sans session.
-- PostgreSQL accorde EXECUTE a PUBLIC par defaut : un appel anonyme atteignait
-- donc le corps de la fonction avant d'etre refuse par `is_platform_admin()`.
-- Le garde faisait son travail, mais autant ne pas laisser la porte s'ouvrir.
REVOKE EXECUTE ON FUNCTION public.platform_overview()              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_companies()             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_plans_list()            FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_payments_list(INTEGER)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_activity(INTEGER)       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_set_plan_price(TEXT, INTEGER, INTEGER)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_set_company_status(UUID, TEXT)          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_record_payment(UUID, INTEGER, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_set_subscription(UUID, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;

-- `is_platform_admin` reste appelable par un compte connecte : c'est elle qui
-- decide si l'onglet de navigation doit apparaitre.
REVOKE EXECUTE ON FUNCTION public.is_platform_admin(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_platform_admin(UUID) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
