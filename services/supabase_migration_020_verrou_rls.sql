-- =============================================================================
--  MIGRATION 020 — Fermeture des politiques RLS ouvertes
-- =============================================================================
--
--  CE QUI ETAIT OUVERT
--  -------------------
--  Six tables portaient une politique `FOR ALL TO public USING (true)` :
--  `users`, `companies`, `company_memberships`, `leaves`, `overtimes` et
--  `audit_logs`. La cle anonyme du site etant publique par construction (elle
--  est dans le JavaScript servi a chaque visiteur), n'importe qui pouvait,
--  sans compte :
--
--    - lire les 8 comptes avec noms, e-mails et numeros de telephone ;
--    - se promouvoir CEO (`update users set role='CEO'`) ;
--    - s'auto-approuver dans une entreprise
--      (`update company_memberships set status='ACTIVE'`) ;
--    - DESACTIVER la reconnaissance faciale et la vivacite de tous les clients
--      (`update companies set face_verification_enabled=false`) — ce qui vide
--      de son sens l'ensemble du dispositif anti-fraude ;
--    - supprimer tous les rattachements, conges et heures supplementaires ;
--    - creer des entreprises et effacer le journal d'audit.
--
--  Verifie sur la base reelle avant ecriture, en transactions annulees.
--
--  PRINCIPE RETENU
--  ---------------
--  Chaque table recoit des politiques par operation, appuyees sur les
--  fonctions de perimetre deja en place : `user_company_ids()`,
--  `can_configure_company()`, `can_view_company_attendance()`. Une operation
--  sans politique est refusee — c'est le comportement par defaut de RLS, et
--  c'est celui qu'on veut pour toute suppression.
--
--  DEUX POINTS QUE LA RLS SEULE NE COUVRE PAS
--  ------------------------------------------
--  1. Un `WITH CHECK` ne voit que la ligne APRES modification : il ne peut pas
--     savoir qu'un employe vient de changer son propre `role`. D'ou le
--     declencheur `users_bloquer_escalade`.
--  2. Les privileges de table restent accordes en plus de la RLS. `anon`
--     detenait DELETE, UPDATE et TRUNCATE sur toutes les tables — et TRUNCATE
--     n'est PAS soumis a la RLS. Ils sont retires en fin de fichier.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. SUPPRESSION DES POLITIQUES OUVERTES
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Public & Anon access on users"                ON public.users;
DROP POLICY IF EXISTS "Allow select users"                           ON public.users;
DROP POLICY IF EXISTS "Allow insert to users"                        ON public.users;
DROP POLICY IF EXISTS "Allow update users"                           ON public.users;

DROP POLICY IF EXISTS "Public & Anon access on companies"            ON public.companies;
DROP POLICY IF EXISTS "Allow select companies"                       ON public.companies;
DROP POLICY IF EXISTS "Allow insert to companies"                    ON public.companies;
DROP POLICY IF EXISTS "Allow update companies"                       ON public.companies;

DROP POLICY IF EXISTS "Public & Anon access on company_memberships"  ON public.company_memberships;
DROP POLICY IF EXISTS "Allow select company_memberships"             ON public.company_memberships;
DROP POLICY IF EXISTS "Allow insert to company_memberships"          ON public.company_memberships;
DROP POLICY IF EXISTS "Allow update company_memberships"             ON public.company_memberships;
DROP POLICY IF EXISTS "Allow delete company_memberships"             ON public.company_memberships;

DROP POLICY IF EXISTS "Allow read leaves"                            ON public.leaves;
DROP POLICY IF EXISTS "Allow insert leaves"                          ON public.leaves;
DROP POLICY IF EXISTS "Allow update leaves"                          ON public.leaves;
DROP POLICY IF EXISTS "Allow delete leaves"                          ON public.leaves;

DROP POLICY IF EXISTS "Allow read overtimes"                         ON public.overtimes;
DROP POLICY IF EXISTS "Allow insert overtimes"                       ON public.overtimes;
DROP POLICY IF EXISTS "Allow update overtimes"                       ON public.overtimes;
DROP POLICY IF EXISTS "Allow delete overtimes"                       ON public.overtimes;

DROP POLICY IF EXISTS "Public & Anon access on audit_logs"           ON public.audit_logs;

-- -----------------------------------------------------------------------------
-- 1. APPARTENANCE
-- -----------------------------------------------------------------------------
--  `users.company_id` et `company_memberships` divergent depuis longtemps sur
--  ce projet. Les politiques consultent donc les DEUX : se fier au seul
--  `company_id` rendrait invisibles des collegues bien rattaches.

CREATE OR REPLACE FUNCTION public.partage_une_entreprise(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = p_user
           AND m.company_id IN (SELECT public.user_company_ids())
    ) OR EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.id = p_user
           AND u.company_id IN (SELECT public.user_company_ids())
    );
$$;

GRANT EXECUTE ON FUNCTION public.partage_une_entreprise(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. users
-- -----------------------------------------------------------------------------

CREATE POLICY users_select_perimetre ON public.users
    FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR public.partage_une_entreprise(id)
        OR public.is_platform_admin()
    );

-- Un compte ne cree que SA propre fiche. L'ancien code retombait sur
-- `crypto.randomUUID()` quand l'inscription n'ouvrait pas de session : trois
-- fiches orphelines en production, rattachees a aucun compte authentifiable.
CREATE POLICY users_insert_soi ON public.users
    FOR INSERT TO authenticated
    WITH CHECK (id = auth.uid());

CREATE POLICY users_update_soi_ou_rh ON public.users
    FOR UPDATE TO authenticated
    USING (
        id = auth.uid()
        OR public.can_configure_company(company_id)
        OR public.is_platform_admin()
    )
    WITH CHECK (
        id = auth.uid()
        OR public.can_configure_company(company_id)
        OR public.is_platform_admin()
    );

-- Aucune politique DELETE : personne ne supprime un compte depuis le navigateur.

/**
 * Empeche l'escalade de privileges lors de la mise a jour de sa propre fiche.
 *
 * Le `WITH CHECK` ci-dessus ne voit que la ligne apres modification : il ne
 * peut pas distinguer « je corrige mon numero de telephone » de « je passe mon
 * role a CEO ». Ce declencheur compare l'avant et l'apres.
 */
CREATE OR REPLACE FUNCTION public.users_bloquer_escalade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Le proprietaire de la base et les traitements internes passent outre.
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    -- Un configurateur de l'entreprise concernee a le droit de changer le role
    -- et le rattachement de ses employes.
    IF public.can_configure_company(COALESCE(OLD.company_id, NEW.company_id)) THEN
        RETURN NEW;
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'Changement de role interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
        RAISE EXCEPTION 'Changement d''entreprise interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        RAISE EXCEPTION 'Changement d''etat du compte interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.attendance_required IS DISTINCT FROM OLD.attendance_required THEN
        RAISE EXCEPTION 'Changement de l''obligation de pointage interdit.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_bloquer_escalade ON public.users;
CREATE TRIGGER users_bloquer_escalade
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.users_bloquer_escalade();

-- -----------------------------------------------------------------------------
-- 3. companies
-- -----------------------------------------------------------------------------

CREATE POLICY companies_select_perimetre ON public.companies
    FOR SELECT TO authenticated
    USING (
        id IN (SELECT public.user_company_ids())
        OR public.is_platform_admin()
    );

-- Pas de politique INSERT : la creation passe par `register_company()`, qui
-- rattache l'entreprise a `auth.uid()` dans la meme transaction. Un INSERT
-- direct laissait sinon creer des entreprises sans aucun proprietaire.
CREATE POLICY companies_update_configurateur ON public.companies
    FOR UPDATE TO authenticated
    USING (public.can_configure_company(id) OR public.is_platform_admin())
    WITH CHECK (public.can_configure_company(id) OR public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 4. company_memberships
-- -----------------------------------------------------------------------------

CREATE POLICY memberships_select_perimetre ON public.company_memberships
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.can_view_company_attendance(company_id)
        OR public.is_platform_admin()
    );

-- Une demande de rattachement ne peut concerner que soi-meme, et arrive
-- toujours EN ATTENTE. C'est ce qui empeche de s'auto-approuver.
CREATE POLICY memberships_insert_demande ON public.company_memberships
    FOR INSERT TO authenticated
    WITH CHECK (
        (user_id = auth.uid() AND COALESCE(status, 'PENDING_APPROVAL') = 'PENDING_APPROVAL')
        OR public.can_configure_company(company_id)
    );

CREATE POLICY memberships_update_rh ON public.company_memberships
    FOR UPDATE TO authenticated
    USING (public.can_configure_company(company_id) OR public.is_platform_admin())
    WITH CHECK (public.can_configure_company(company_id) OR public.is_platform_admin());

CREATE POLICY memberships_delete_rh ON public.company_memberships
    FOR DELETE TO authenticated
    USING (public.can_configure_company(company_id) OR public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 5. leaves et overtimes
-- -----------------------------------------------------------------------------

CREATE POLICY leaves_select_perimetre ON public.leaves
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.can_view_company_attendance(company_id)
        OR public.is_platform_admin()
    );

CREATE POLICY leaves_insert_soi ON public.leaves
    FOR INSERT TO authenticated
    WITH CHECK (
        (user_id = auth.uid() AND company_id IN (SELECT public.user_company_ids()))
        OR public.can_configure_company(company_id)
    );

-- Un employe ne modifie sa demande que tant qu'elle est en attente ; la
-- decision appartient au service RH.
CREATE POLICY leaves_update ON public.leaves
    FOR UPDATE TO authenticated
    USING (
        (user_id = auth.uid() AND lower(COALESCE(status, '')) LIKE 'en attente%')
        OR public.can_configure_company(company_id)
    )
    WITH CHECK (
        user_id = auth.uid() OR public.can_configure_company(company_id)
    );

CREATE POLICY leaves_delete ON public.leaves
    FOR DELETE TO authenticated
    USING (
        (user_id = auth.uid() AND lower(COALESCE(status, '')) LIKE 'en attente%')
        OR public.can_configure_company(company_id)
    );

CREATE POLICY overtimes_select_perimetre ON public.overtimes
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.can_view_company_attendance(company_id)
        OR public.is_platform_admin()
    );

-- Le service RH declare aussi des heures pour un employe : la politique
-- accepte donc les deux origines.
CREATE POLICY overtimes_insert ON public.overtimes
    FOR INSERT TO authenticated
    WITH CHECK (
        (user_id = auth.uid() AND company_id IN (SELECT public.user_company_ids()))
        OR public.can_configure_company(company_id)
    );

CREATE POLICY overtimes_update ON public.overtimes
    FOR UPDATE TO authenticated
    USING (
        (user_id = auth.uid() AND lower(COALESCE(status, '')) LIKE 'en attente%')
        OR public.can_configure_company(company_id)
    )
    WITH CHECK (
        user_id = auth.uid() OR public.can_configure_company(company_id)
    );

CREATE POLICY overtimes_delete ON public.overtimes
    FOR DELETE TO authenticated
    USING (
        (user_id = auth.uid() AND lower(COALESCE(status, '')) LIKE 'en attente%')
        OR public.can_configure_company(company_id)
    );

-- -----------------------------------------------------------------------------
-- 6. audit_logs — un journal ne se modifie pas
-- -----------------------------------------------------------------------------

CREATE POLICY audit_select_perimetre ON public.audit_logs
    FOR SELECT TO authenticated
    USING (
        public.can_view_company_attendance(company_id)
        OR public.is_platform_admin()
    );

CREATE POLICY audit_insert_membre ON public.audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (company_id IN (SELECT public.user_company_ids()));

-- Ni UPDATE ni DELETE : effacer ses traces ne doit pas etre possible.

-- -----------------------------------------------------------------------------
-- 7. RETRAIT DES PRIVILEGES DE TABLE
-- -----------------------------------------------------------------------------
--  La RLS filtre les lignes, mais elle ne s'applique pas a TRUNCATE. Tant que
--  `anon` conserve ce privilege, une seule commande suffirait a vider une
--  table entiere sans qu'aucune politique n'intervienne.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
    LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
        -- Un visiteur sans compte n'ecrit jamais directement : ce qu'il a le
        -- droit de faire passe par des fonctions verrouillees.
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', t);
    END LOOP;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
