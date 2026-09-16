-- =============================================================================
--  MIGRATION 024 — Le service RH doit pouvoir inscrire un employe
-- =============================================================================
--
--  La migration 020 a restreint l'INSERT sur `users` a `id = auth.uid()`, pour
--  fermer le repli `crypto.randomUUID()` qui laissait creer des fiches sans
--  compte associe.
--
--  Mais le Cockpit RH cree legitimement la fiche d'un employe AVANT que
--  celui-ci n'ait de compte : le formulaire « Ajouter un employe » genere un
--  matricule, une fiche et une invitation. Sans cette politique, ce parcours
--  echoue.
--
--  Pourquoi c'est sans danger : la fiche est forcement rattachee a une
--  entreprise que l'auteur configure deja, et la cle primaire empeche de
--  viser l'identifiant d'un compte existant. Le role inscrit sur la fiche ne
--  confere par ailleurs plus aucun droit par lui-meme : depuis la migration
--  022, seules les lignes de `company_memberships` font autorite.
-- =============================================================================

BEGIN;

CREATE POLICY users_insert_rh ON public.users
    FOR INSERT TO authenticated
    WITH CHECK (public.can_configure_company(company_id));

COMMIT;

NOTIFY pgrst, 'reload schema';
