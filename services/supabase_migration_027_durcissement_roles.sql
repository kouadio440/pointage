-- =============================================================================
--  MIGRATION 027 — DURCISSEMENT DES ROLES, DE L'ABONNEMENT ET DES SELFIES
-- =============================================================================
--
--  Compatible avec le site actuellement en ligne ET avec la refonte de la
--  connexion : aucun libelle de role n'est renomme ici (voir 028), aucune
--  donnee n'est modifiee. Seuls des controles sont ajoutes.
--
--  CE QUI ETAIT POSSIBLE AVANT CETTE MIGRATION
--  -------------------------------------------
--  1. Un administrateur RH pouvait modifier SON PROPRE rattachement et se
--     nommer « CEO » (politique memberships_update_rh), puis retirer le
--     proprietaire. Il pouvait aussi nommer n'importe qui proprietaire.
--  2. Une demande d'adhesion inseree directement (politique
--     memberships_insert_demande) pouvait porter le role « CEO » : il
--     suffisait que le RH l'approuve pour creer un proprietaire.
--  3. Un proprietaire ou un RH pouvait modifier lui-meme l'abonnement de son
--     entreprise (plan, status, max_employees) et reactiver une entreprise
--     suspendue pour impaye, ou fabriquer un code entreprise previsible.
--  4. CRITIQUE — la lecture des selfies de pointage etait accordee a tout
--     compte dont la fiche `users` portait CEO, HR ou MANAGER, QUELLE QUE SOIT
--     son entreprise ; et un compte neuf pouvait creer sa propre fiche avec le
--     role « CEO » (politique users_insert_soi). Tout inscrit pouvait donc lire
--     les selfies de toutes les entreprises.
--
--  PRINCIPE
--  --------
--  Les controles ne visent que les requetes directes des navigateurs
--  (roles `anon` et `authenticated`). Les fonctions serveur SECURITY DEFINER
--  (create_company, regenerate_company_code, platform_set_subscription...)
--  s'executent sous le role proprietaire des fonctions et ne sont pas
--  concernees : elles font deja leurs propres verifications. Les declencheurs
--  sont donc volontairement SECURITY INVOKER : `current_user` y designe bien
--  l'appelant.
--
--  RETOUR ARRIERE
--  --------------
--    DROP TRIGGER IF EXISTS aa_memberships_proteger_roles ON public.company_memberships;
--    DROP TRIGGER IF EXISTS aa_companies_champs_reserves ON public.companies;
--    DROP TRIGGER IF EXISTS aa_users_role_a_la_creation ON public.users;
--  puis recreer les deux politiques de stockage de la migration 002.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. OUTILS
-- -----------------------------------------------------------------------------

/** Vrai pour une requete directe d'un navigateur (PostgREST), faux dans une fonction serveur. */
CREATE OR REPLACE FUNCTION public.appel_direct_client()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT current_user IN ('anon', 'authenticated');
$$;

GRANT EXECUTE ON FUNCTION public.appel_direct_client() TO anon, authenticated;

/** Le compte connecte est-il proprietaire actif de cette entreprise ? */
CREATE OR REPLACE FUNCTION public.est_proprietaire(p_company UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.company_id = p_company
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) = 'OWNER'
    );
$$;

REVOKE ALL ON FUNCTION public.est_proprietaire(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.est_proprietaire(UUID) TO authenticated;

/**
 * Nombre de proprietaires actifs. Reserve a qui administre l'entreprise :
 * pour tout autre compte, la reponse est NULL (rien n'est revele).
 */
CREATE OR REPLACE FUNCTION public.proprietaires_actifs(p_company UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE WHEN public.can_configure_company(p_company) OR public.is_platform_admin() THEN (
        SELECT count(*)::INTEGER FROM public.company_memberships m
         WHERE m.company_id = p_company
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) = 'OWNER'
    ) END;
$$;

REVOKE ALL ON FUNCTION public.proprietaires_actifs(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proprietaires_actifs(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. RATTACHEMENTS : PERSONNE NE S'ATTRIBUE UN ROLE
-- -----------------------------------------------------------------------------
--  - une demande d'adhesion deposee par l'interesse porte toujours EMPLOYEE ;
--  - personne ne modifie son propre role ;
--  - seul un proprietaire nomme, retire, suspend ou supprime un proprietaire ;
--  - une entreprise garde toujours au moins un proprietaire actif ;
--  - un rattachement ne change ni de compte ni d'entreprise.

CREATE OR REPLACE FUNCTION public.memberships_proteger_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_ancien  TEXT;
    v_nouveau TEXT;
BEGIN
    IF NOT public.appel_direct_client() OR public.is_platform_admin() THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_nouveau := public.normaliser_role_membre(NEW.role);

        IF NOT public.can_configure_company(NEW.company_id) THEN
            IF v_nouveau <> 'EMPLOYEE' THEN
                RAISE EXCEPTION 'Une demande d''adhésion porte uniquement le rôle employé.'
                    USING ERRCODE = '42501', HINT = 'ROLE_DEMANDE_INTERDIT';
            END IF;
            RETURN NEW;
        END IF;

        IF v_nouveau = 'OWNER' AND NOT public.est_proprietaire(NEW.company_id) THEN
            RAISE EXCEPTION 'Seul le propriétaire peut nommer un propriétaire.'
                USING ERRCODE = '42501', HINT = 'PROPRIETAIRE_REQUIS';
        END IF;
        RETURN NEW;
    END IF;

    v_ancien := public.normaliser_role_membre(OLD.role);

    IF TG_OP = 'UPDATE' THEN
        IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
            RAISE EXCEPTION 'Un rattachement ne change ni de compte ni d''entreprise.'
                USING ERRCODE = '42501', HINT = 'RATTACHEMENT_DEPLACE';
        END IF;

        v_nouveau := public.normaliser_role_membre(NEW.role);

        IF v_nouveau IS DISTINCT FROM v_ancien THEN
            IF OLD.user_id = v_uid THEN
                RAISE EXCEPTION 'Vous ne pouvez pas modifier votre propre rôle.'
                    USING ERRCODE = '42501', HINT = 'ROLE_SOI_MEME';
            END IF;
            IF (v_ancien = 'OWNER' OR v_nouveau = 'OWNER') AND NOT public.est_proprietaire(OLD.company_id) THEN
                RAISE EXCEPTION 'Seul le propriétaire peut attribuer ou retirer le rôle de propriétaire.'
                    USING ERRCODE = '42501', HINT = 'PROPRIETAIRE_REQUIS';
            END IF;
        END IF;

        IF v_ancien = 'OWNER' AND NEW.status IS DISTINCT FROM OLD.status
           AND NOT public.est_proprietaire(OLD.company_id) THEN
            RAISE EXCEPTION 'Seul le propriétaire peut modifier l''accès d''un propriétaire.'
                USING ERRCODE = '42501', HINT = 'PROPRIETAIRE_REQUIS';
        END IF;

        IF v_ancien = 'OWNER' AND OLD.status = 'ACTIVE'
           AND (v_nouveau <> 'OWNER' OR NEW.status IS DISTINCT FROM 'ACTIVE')
           AND public.proprietaires_actifs(OLD.company_id) <= 1 THEN
            RAISE EXCEPTION 'L''entreprise doit garder au moins un propriétaire actif.'
                USING ERRCODE = '42501', HINT = 'DERNIER_PROPRIETAIRE';
        END IF;

        RETURN NEW;
    END IF;

    -- DELETE
    IF v_ancien = 'OWNER' THEN
        IF NOT public.est_proprietaire(OLD.company_id) THEN
            RAISE EXCEPTION 'Seul le propriétaire peut retirer un propriétaire.'
                USING ERRCODE = '42501', HINT = 'PROPRIETAIRE_REQUIS';
        END IF;
        IF OLD.status = 'ACTIVE' AND public.proprietaires_actifs(OLD.company_id) <= 1 THEN
            RAISE EXCEPTION 'L''entreprise doit garder au moins un propriétaire actif.'
                USING ERRCODE = '42501', HINT = 'DERNIER_PROPRIETAIRE';
        END IF;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS aa_memberships_proteger_roles ON public.company_memberships;
CREATE TRIGGER aa_memberships_proteger_roles
    BEFORE INSERT OR UPDATE OR DELETE ON public.company_memberships
    FOR EACH ROW EXECUTE FUNCTION public.memberships_proteger_roles();

-- -----------------------------------------------------------------------------
-- 3. FICHE `users` : UN COMPTE NE SE CREE PAS UNE FICHE D'ADMINISTRATEUR
-- -----------------------------------------------------------------------------
--  Le role porte par `users` ne donne plus aucun droit (les autorisations
--  lisent les rattachements), mais d'anciennes regles le lisaient encore :
--  la fiche creee par l'interesse lui-meme est donc toujours « employe ».

CREATE OR REPLACE FUNCTION public.users_role_a_la_creation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NOT public.appel_direct_client() OR public.is_platform_admin() THEN
        RETURN NEW;
    END IF;
    IF public.normaliser_role_membre(NEW.role) <> 'EMPLOYEE'
       AND NOT public.can_configure_company(NEW.company_id) THEN
        RAISE EXCEPTION 'Rôle non autorisé pour cette fiche.'
            USING ERRCODE = '42501', HINT = 'ROLE_FICHE_INTERDIT';
    END IF;
    IF public.normaliser_role_membre(NEW.role) = 'OWNER'
       AND NOT public.est_proprietaire(NEW.company_id) THEN
        RAISE EXCEPTION 'Seul le propriétaire peut créer une fiche de propriétaire.'
            USING ERRCODE = '42501', HINT = 'PROPRIETAIRE_REQUIS';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_users_role_a_la_creation ON public.users;
CREATE TRIGGER aa_users_role_a_la_creation
    BEFORE INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.users_role_a_la_creation();

-- Meme regle pour l'ancienne fonction d'autorisation, qui lisait `users.role`
-- (sans usage actuel en base, mais appelable) : elle suit les rattachements.
CREATE OR REPLACE FUNCTION public.is_company_configurator()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.is_platform_admin() OR EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
    );
$$;

-- -----------------------------------------------------------------------------
-- 4. ENTREPRISE : ABONNEMENT ET CODE RESERVES
-- -----------------------------------------------------------------------------
--  L'abonnement (plan, statut, plafond d'employes) se regle depuis la console
--  plateforme ; le code entreprise se regenere par regenerate_company_code().
--  Les reglages de pointage restent modifiables par le proprietaire et le RH.

CREATE OR REPLACE FUNCTION public.companies_champs_reserves()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NOT public.appel_direct_client() OR public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.max_employees IS DISTINCT FROM OLD.max_employees THEN
        RAISE EXCEPTION 'L''abonnement de l''entreprise est géré par Timora.'
            USING ERRCODE = '42501', HINT = 'ABONNEMENT_RESERVE';
    END IF;

    IF NEW.company_code IS DISTINCT FROM OLD.company_code THEN
        RAISE EXCEPTION 'Le code entreprise se régénère depuis le cockpit, par le propriétaire.'
            USING ERRCODE = '42501', HINT = 'CODE_RESERVE';
    END IF;

    IF NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.onboarding_completed IS DISTINCT FROM OLD.onboarding_completed THEN
        RAISE EXCEPTION 'Champ réservé.'
            USING ERRCODE = '42501', HINT = 'CHAMP_RESERVE';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_companies_champs_reserves ON public.companies;
CREATE TRIGGER aa_companies_champs_reserves
    BEFORE UPDATE ON public.companies
    FOR EACH ROW EXECUTE FUNCTION public.companies_champs_reserves();

-- -----------------------------------------------------------------------------
-- 5. SELFIES DE POINTAGE : CLOISONNES PAR ENTREPRISE
-- -----------------------------------------------------------------------------
--  Chemin d'un selfie : <identifiant du compte>/<horodatage>_<type>.jpg
--  (verifie : tous les fichiers existants suivent ce format).
--
--  Lecture : l'employe lui-meme, ou un proprietaire / administrateur /
--  manager ACTIF d'une entreprise dont l'employe est membre.
--  Depot : uniquement dans son propre dossier.

CREATE OR REPLACE FUNCTION public.peut_voir_selfie(p_dossier TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.is_platform_admin() OR EXISTS (
        SELECT 1
          FROM public.company_memberships cible
          JOIN public.company_memberships moi ON moi.company_id = cible.company_id
         WHERE cible.user_id::TEXT = p_dossier
           AND moi.user_id = auth.uid()
           AND moi.status = 'ACTIVE'
           AND public.normaliser_role_membre(moi.role) IN ('OWNER', 'ADMIN', 'MANAGER')
    );
$$;

REVOKE ALL ON FUNCTION public.peut_voir_selfie(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peut_voir_selfie(TEXT) TO authenticated;

DROP POLICY IF EXISTS "punch_selfies_read_restricted" ON storage.objects;
CREATE POLICY "punch_selfies_read_restricted" ON storage.objects
FOR SELECT TO authenticated
USING (
    bucket_id = 'punch-selfies'
    AND (
        (storage.foldername(name))[1] = auth.uid()::TEXT
        OR public.peut_voir_selfie((storage.foldername(name))[1])
    )
);

DROP POLICY IF EXISTS "punch_selfies_insert_authenticated" ON storage.objects;
CREATE POLICY "punch_selfies_insert_authenticated" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'punch-selfies'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
);

COMMIT;
