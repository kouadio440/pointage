-- =============================================================================
--  MIGRATION 030 — UNE ADHESION N'EST ACTIVEE QUE PAR UNE APPROBATION EXPLICITE
-- =============================================================================
--
--  POURQUOI
--  --------
--  Le cockpit contenait une « reconciliation » : toute demande en attente dont
--  la fiche `users` etait active et rattachee a la meme entreprise etait
--  passee en ACTIVE automatiquement, sans que personne ne l'approuve.
--
--  Or `join_company()` cree justement la fiche avec is_active = TRUE au moment
--  de la demande. Chaque demande ressemblait donc a une « approbation a demi
--  terminee » : au premier chargement du cockpit, toutes les demandes en
--  attente devenaient des membres actifs, en silence.
--
--  CE QUE CETTE MIGRATION POSE
--  ---------------------------
--  Depuis un navigateur, un rattachement ne peut plus passer a ACTIVE par une
--  simple ecriture : il faut appeler approve_join_request(), qui verifie les
--  droits, l'entreprise et le statut, puis ecrit tout en une transaction.
--  Les fonctions serveur (create_company, join_company, approve_join_request)
--  ne sont pas concernees : elles ne s'executent pas sous le role du navigateur.
--
--  Les autres changements de statut restent possibles (REJECTED, SUSPENDED,
--  reactivation d'un membre deja actif), ainsi que toutes les autres colonnes.
--
--  RETOUR ARRIERE
--  --------------
--    DROP TRIGGER IF EXISTS ab_memberships_activation_explicite ON public.company_memberships;
--    DROP FUNCTION IF EXISTS public.memberships_activation_explicite();
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.memberships_activation_explicite()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Fonctions serveur, service_role, migrations : hors perimetre.
    --
    -- Un administrateur de la plateforme n'est PAS exempte : approuver un
    -- employe reste la decision de son entreprise, et le compte qui administre
    -- Timora est aussi le proprietaire d'une entreprise cliente.
    IF NOT public.appel_direct_client() THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'ACTIVE'
       AND OLD.status IS DISTINCT FROM 'ACTIVE'
       AND OLD.status IN ('PENDING_APPROVAL', 'INVITED', 'REJECTED') THEN
        RAISE EXCEPTION 'Une demande s''approuve par le bouton prévu, jamais par une écriture directe.'
            USING ERRCODE = '42501', HINT = 'APPROBATION_EXPLICITE_REQUISE';
    END IF;

    RETURN NEW;
END;
$$;

-- Nom en « ab_ » : apres aa_memberships_proteger_roles (migration 027),
-- avant les eventuels declencheurs suivants.
DROP TRIGGER IF EXISTS ab_memberships_activation_explicite ON public.company_memberships;
CREATE TRIGGER ab_memberships_activation_explicite
    BEFORE UPDATE ON public.company_memberships
    FOR EACH ROW EXECUTE FUNCTION public.memberships_activation_explicite();

COMMIT;
