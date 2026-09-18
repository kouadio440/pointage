-- =============================================================================
--  RETOUR ARRIERE DE LA MIGRATION 032 (avis)
-- =============================================================================
--  Retire les fonctions : la section Avis n'affiche plus rien et plus aucun
--  avis ne peut etre depose. La table public.reviews et son contenu sont
--  CONSERVES (aucune donnee supprimee).
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.moderate_review(UUID, TEXT);
DROP FUNCTION IF EXISTS public.reviews_moderation_list(TEXT);
DROP FUNCTION IF EXISTS public.my_review();
DROP FUNCTION IF EXISTS public.submit_review(INT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.reviews_public(INT);
DROP FUNCTION IF EXISTS public.avis_client_reel(UUID);
DROP FUNCTION IF EXISTS public.avis_nom_public(TEXT);
DROP FUNCTION IF EXISTS public.avis_nettoyer(TEXT);

COMMIT;

NOTIFY pgrst, 'reload schema';
