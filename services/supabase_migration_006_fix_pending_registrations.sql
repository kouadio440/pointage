-- =============================================================================
-- Winner Pointage — Migration 006 : Support complet des demandes d'inscription &
-- affectation directe aux sites & horaires de la configuration du pointage.
--
-- Idempotente. À exécuter après la migration 005.
-- =============================================================================

-- 1. Ajout des colonnes de site et d'horaire par défaut sur company_memberships & users
ALTER TABLE public.company_memberships
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.work_schedules(id) ON DELETE SET NULL;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.work_schedules(id) ON DELETE SET NULL;

-- 2. Politiques RLS pour autoriser la lecture et la validation des demandes d'inscription en attente
DROP POLICY IF EXISTS "memberships_select_company_configurator" ON public.company_memberships;
CREATE POLICY "memberships_select_company_configurator" ON public.company_memberships
FOR SELECT TO authenticated
USING (company_id IN (SELECT public.user_company_ids()) OR status IN ('PENDING_APPROVAL', 'PENDING', 'pending'));

DROP POLICY IF EXISTS "memberships_update_company_configurator" ON public.company_memberships;
CREATE POLICY "memberships_update_company_configurator" ON public.company_memberships
FOR UPDATE TO authenticated
USING (public.can_configure_company(company_id))
WITH CHECK (public.can_configure_company(company_id));

DROP POLICY IF EXISTS "users_select_company_configurator" ON public.users;
CREATE POLICY "users_select_company_configurator" ON public.users
FOR SELECT TO authenticated
USING (company_id IN (SELECT public.user_company_ids()) OR is_active = false);

DROP POLICY IF EXISTS "users_update_company_configurator" ON public.users;
CREATE POLICY "users_update_company_configurator" ON public.users
FOR UPDATE TO authenticated
USING (public.can_configure_company(company_id))
WITH CHECK (public.can_configure_company(company_id));
