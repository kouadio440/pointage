-- =============================================================================
-- Winner Pointage — Migration 004 : RLS multi-entreprises
--
-- À exécuter APRÈS supabase_migration_003_rh_config.sql. Idempotente.
--
-- CORRECTIF
-- ---------
-- Les politiques de la migration 003 comparaient le company_id d'une ligne à
-- `users.company_id` UNIQUEMENT. Or l'application gère le multi-entreprises via
-- public.company_memberships : un même compte peut être CEO de « winner design »
-- tout en ayant un `users.company_id` pointant sur une autre entreprise.
--
-- Résultat observé : un CEO travaillant dans son Cockpit sur l'entreprise A se
-- voyait refuser la création d'un site, car la politique attendait l'entreprise B
-- inscrite sur sa fiche utilisateur. Erreur :
--   « new row violates row-level security policy for table geofences »
--
-- On fait donc de company_memberships la source de vérité, avec repli sur
-- users.company_id pour les comptes qui n'ont pas encore de rattachement.
-- =============================================================================


-- =============================================================================
-- 1. Entreprises auxquelles l'utilisateur appartient légitimement
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_company_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    -- Rattachements explicites et actifs (source principale, multi-entreprises).
    SELECT m.company_id
      FROM public.company_memberships m
     WHERE m.user_id = auth.uid()
       AND m.status = 'ACTIVE'
    UNION
    -- Repli : comptes créés avant la gestion des rattachements.
    SELECT u.company_id
      FROM public.users u
     WHERE u.id = auth.uid()
       AND u.company_id IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.user_company_ids() TO authenticated;


-- =============================================================================
-- 2. Peut-il CONFIGURER cette entreprise précise ?
--
-- Le rôle est évalué POUR CETTE ENTREPRISE : être CEO de l'entreprise A ne doit
-- donner aucun droit de configuration sur l'entreprise B.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.can_configure_company(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.company_id = p_company_id
           AND m.status = 'ACTIVE'
           AND upper(m.role) IN ('CEO', 'HR', 'COMPANY_ADMIN', 'SUPER_ADMIN')
    )
    OR EXISTS (
        SELECT 1
          FROM public.users u
         WHERE u.id = auth.uid()
           AND u.company_id = p_company_id
           AND upper(u.role) IN ('CEO', 'HR', 'COMPANY_ADMIN', 'SUPER_ADMIN')
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_configure_company(UUID) TO authenticated;


-- Lecture des pointages : même logique, étendue aux managers.
CREATE OR REPLACE FUNCTION public.can_view_company_attendance(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.company_id = p_company_id
           AND m.status = 'ACTIVE'
           AND upper(m.role) IN ('CEO', 'HR', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN')
    )
    OR EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.id = auth.uid()
           AND u.company_id = p_company_id
           AND upper(u.role) IN ('CEO', 'HR', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN')
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_company_attendance(UUID) TO authenticated;


-- =============================================================================
-- 3. Politiques reconstruites sur les tables de configuration
-- =============================================================================

-- --- Sites -------------------------------------------------------------------
DROP POLICY IF EXISTS "geofences_select_company" ON public.geofences;
CREATE POLICY "geofences_select_company" ON public.geofences
FOR SELECT TO authenticated
USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "geofences_write_configurator" ON public.geofences;
CREATE POLICY "geofences_write_configurator" ON public.geofences
FOR ALL TO authenticated
USING (public.can_configure_company(company_id))
WITH CHECK (public.can_configure_company(company_id));

-- --- Horaires ----------------------------------------------------------------
DROP POLICY IF EXISTS "schedules_select_company" ON public.work_schedules;
CREATE POLICY "schedules_select_company" ON public.work_schedules
FOR SELECT TO authenticated
USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "schedules_write_configurator" ON public.work_schedules;
CREATE POLICY "schedules_write_configurator" ON public.work_schedules
FOR ALL TO authenticated
USING (public.can_configure_company(company_id))
WITH CHECK (public.can_configure_company(company_id));

-- --- Sites additionnels ------------------------------------------------------
DROP POLICY IF EXISTS "employee_sites_select_company" ON public.employee_sites;
CREATE POLICY "employee_sites_select_company" ON public.employee_sites
FOR SELECT TO authenticated
USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "employee_sites_write_configurator" ON public.employee_sites;
CREATE POLICY "employee_sites_write_configurator" ON public.employee_sites
FOR ALL TO authenticated
USING (public.can_configure_company(company_id))
WITH CHECK (public.can_configure_company(company_id));

-- --- Pointages : lecture -----------------------------------------------------
DROP POLICY IF EXISTS "attendances_select_own_or_company" ON public.attendances;
CREATE POLICY "attendances_select_own_or_company" ON public.attendances
FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.can_view_company_attendance(company_id));

DROP POLICY IF EXISTS "attempts_select_own_or_company" ON public.attendance_attempts;
CREATE POLICY "attempts_select_own_or_company" ON public.attendance_attempts
FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.can_view_company_attendance(company_id));
