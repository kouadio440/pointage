-- =============================================================================
--  MIGRATION 023 — Droits d'execution des fonctions
-- =============================================================================
--
--  LE DEFAUT DE POSTGRESQL
--  -----------------------
--  Toute fonction nouvellement creee accorde EXECUTE a PUBLIC. Les trente et
--  une fonctions du projet etaient donc appelables sans aucune session, avec
--  la seule cle anonyme du site.
--
--  La plupart se defendaient seules — `record_attendance`, `enroll_face`,
--  `issue_face_challenge` ou `rotate_site_qr_secret` verifient `auth.uid()` et
--  refusent un appel anonyme. Verifie une par une sur la base reelle.
--
--  DEUX NE SE DEFENDAIENT PAS
--  --------------------------
--    purge_face_challenges()  appelee sans session, elle a supprime les 21
--                             defis de vivacite en attente. Repete en boucle,
--                             elle empeche tout pointage facial : chaque defi
--                             emis disparait avant d'etre consomme.
--
--    purge_qr_consumed()      elle vide la table anti-rejeu du QR kiosque.
--                             Sans cette table, un jeton QR deja utilise
--                             redevient valide — le controle anti-rejeu tombe.
--
--  Ce sont deux fonctions d'entretien. Elles n'ont jamais eu a etre joignables
--  depuis un navigateur : seul un travail planifie les appelle.
--
--  PRINCIPE RETENU
--  ---------------
--  On retire EXECUTE a PUBLIC et `anon` sur toutes les fonctions du schema,
--  puis on rend le droit a `authenticated` sur une liste blanche explicite :
--  les fonctions que le navigateur appelle reellement (relevees dans app.js)
--  et celles dont les politiques RLS ont besoin pour s'evaluer.
--
--  Une fonction absente de cette liste n'est plus joignable depuis le client.
--  Les appels internes continuent de fonctionner : dans une fonction
--  SECURITY DEFINER, c'est le proprietaire qui execute, pas l'appelant.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. TOUT FERMER
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    f RECORD;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 2. ROUVRIR CE QUI EST REELLEMENT APPELE
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    f RECORD;
    -- Appelees depuis le navigateur (relevees par `.rpc('...')` dans app.js),
    -- plus les cinq fonctions de perimetre dont les politiques RLS dependent :
    -- sans EXECUTE, chaque politique qui les invoque echouerait.
    autorisees TEXT[] := ARRAY[
        'record_attendance', 'enroll_face', 'revoke_my_face', 'my_face_status',
        'diagnose_face', 'issue_face_challenge', 'company_face_enrollment',
        'get_employee_punch_config', 'generate_site_qr_token', 'rotate_site_qr_secret',
        'decide_lateness', 'justify_lateness', 'generate_next_employee_number',
        'register_company', 'join_company', 'lookup_company_by_code',
        'is_platform_admin', 'platform_overview', 'platform_companies',
        'platform_plans_list', 'platform_payments_list', 'platform_activity',
        'platform_set_plan_price', 'platform_set_company_status',
        'platform_set_subscription', 'platform_record_payment',
        'user_company_ids', 'can_configure_company', 'can_view_company_attendance',
        'partage_une_entreprise'
    ];
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS signature, p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname = ANY (autorisees)
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
    END LOOP;
END $$;

-- Seule ouverture laissee au visiteur sans compte : reconnaitre un code
-- entreprise pour s'inscrire. Elle ne renvoie que le nom et l'etat.
GRANT EXECUTE ON FUNCTION public.lookup_company_by_code(TEXT) TO anon;

-- -----------------------------------------------------------------------------
-- 3. L'ENTRETIEN RESTE HORS DE PORTEE DU CLIENT
-- -----------------------------------------------------------------------------
--  `service_role` est la cle serveur : elle ne circule jamais dans un
--  navigateur. C'est le seul role qui doit pouvoir purger.

GRANT EXECUTE ON FUNCTION public.purge_face_challenges() TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_qr_consumed()     TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
