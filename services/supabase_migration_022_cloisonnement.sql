-- =============================================================================
--  MIGRATION 022 — Cloisonnement : les rattachements font seuls autorite
-- =============================================================================
--
--  LA FAILLE
--  ---------
--  Les trois fonctions de perimetre — `user_company_ids()`,
--  `can_configure_company()` et `can_view_company_attendance()` — retombaient
--  sur `users.company_id` lorsqu'aucun rattachement ne correspondait. Ce repli
--  avait ete ajoute pour les comptes anterieurs a la table des rattachements.
--
--  Mais `users.company_id` a derive. Releve sur la base reelle avant
--  correction :
--
--    N'guessan         fiche=sigma plus 2   rattachement=winner design (ACTIVE)
--    mouaheba          fiche=sigma plus 2   rattachement=babi imprim   (ACTIVE)
--    kouassi bertrand  fiche=sigma plus 2   rattachement=winner design (INVITED)
--    konan konan paul  fiche=sigma plus 2   rattachement=winner design (INVITED)
--
--  Consequences mesurees :
--
--    - les DEUX CEO pouvaient CONFIGURER « sigma plus 2 » — changer ses
--      reglages de reconnaissance faciale, ses sites, ses horaires — sans en
--      etre membres ;
--    - `kouassi bertrand` et `konan konan paul`, seulement INVITES chez
--      winner design et donc censes n'avoir aucun acces, lisaient l'integralite
--      de « sigma plus 2 ».
--
--  Le repli accordait donc des droits sur une entreprise d'apres un champ
--  obsolete, que le code d'inscription remplissait de travers.
--
--  CE QUI EST FAIT
--  ---------------
--  1. `users.company_id` est reconstruit depuis les rattachements reels.
--  2. Le repli disparait : un acces se prouve par un rattachement ACTIF.
--
--  PERSONNE NE PERD UN ACCES LEGITIME : tous les comptes possedent une ligne
--  de rattachement. Les deux comptes seulement INVITES perdent un acces
--  qu'ils n'auraient jamais du avoir — ils le retrouveront a l'approbation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. REPARATION DE LA DERIVE
-- -----------------------------------------------------------------------------
--  Priorite au rattachement ACTIF ; a defaut, celui en cours (invitation ou
--  demande), pour que la fiche designe la bonne entreprise des l'inscription.

UPDATE public.users u
   SET company_id = choix.company_id
  FROM (
        SELECT DISTINCT ON (m.user_id)
               m.user_id,
               m.company_id
          FROM public.company_memberships m
         ORDER BY m.user_id,
                  CASE m.status
                       WHEN 'ACTIVE'           THEN 1
                       WHEN 'PENDING_APPROVAL' THEN 2
                       WHEN 'INVITED'          THEN 3
                       ELSE 4
                  END,
                  m.created_at
       ) AS choix
 WHERE choix.user_id = u.id
   AND u.company_id IS DISTINCT FROM choix.company_id;

-- -----------------------------------------------------------------------------
-- 2. LES RATTACHEMENTS FONT SEULS AUTORITE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_company_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    -- Source unique. L'ancien repli sur `users.company_id` ouvrait un acces
    -- transversal des que ce champ derivait (migration 022).
    SELECT m.company_id
      FROM public.company_memberships m
     WHERE m.user_id = auth.uid()
       AND m.status = 'ACTIVE';
$$;

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
    );
$$;

CREATE OR REPLACE FUNCTION public.can_view_company_attendance(p_company_id UUID)
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
           AND upper(m.role) IN ('CEO', 'HR', 'MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN')
    );
$$;

-- -----------------------------------------------------------------------------
-- 3. L'ADMIN PLATEFORME N'ECRIT PLUS EN DIRECT
-- -----------------------------------------------------------------------------
--  Le tableau de bord super admin passe exclusivement par des fonctions
--  SECURITY DEFINER, qui ne sont pas soumises a la RLS. Garder en plus un
--  droit d'ecriture directe sur toutes les entreprises et tous les comptes
--  elargissait la surface sans rien apporter : si la session du proprietaire
--  etait detournee, elle permettait de tout reecrire table par table.
--  La lecture reste ouverte : le support en a besoin.

DROP POLICY IF EXISTS companies_update_configurateur ON public.companies;
CREATE POLICY companies_update_configurateur ON public.companies
    FOR UPDATE TO authenticated
    USING (public.can_configure_company(id))
    WITH CHECK (public.can_configure_company(id));

DROP POLICY IF EXISTS users_update_soi_ou_rh ON public.users;
CREATE POLICY users_update_soi_ou_rh ON public.users
    FOR UPDATE TO authenticated
    USING (id = auth.uid() OR public.can_configure_company(company_id))
    WITH CHECK (id = auth.uid() OR public.can_configure_company(company_id));

DROP POLICY IF EXISTS memberships_update_rh ON public.company_memberships;
CREATE POLICY memberships_update_rh ON public.company_memberships
    FOR UPDATE TO authenticated
    USING (public.can_configure_company(company_id))
    WITH CHECK (public.can_configure_company(company_id));

DROP POLICY IF EXISTS memberships_delete_rh ON public.company_memberships;
CREATE POLICY memberships_delete_rh ON public.company_memberships
    FOR DELETE TO authenticated
    USING (public.can_configure_company(company_id));

COMMIT;

NOTIFY pgrst, 'reload schema';
