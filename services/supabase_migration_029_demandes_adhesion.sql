-- =============================================================================
--  MIGRATION 029 — LES DEMANDES D'ADHESION REDEVIENNENT VISIBLES
-- =============================================================================
--
--  LE DEFAUT CONSTATE
--  ------------------
--  Une employee (Davilla LEGRE) envoie sa demande le 03/09 : la ligne existe
--  bien dans `company_memberships` (status PENDING_APPROVAL, bonne entreprise).
--  Pourtant le cockpit RH affiche « Aucune demande ».
--
--  Le navigateur demandait :
--
--      /rest/v1/company_memberships?select=id,user_id,...,users(id,full_name,...)
--
--  PostgREST repondait :
--
--      400 PGRST200 — Could not find a relationship between
--      'company_memberships' and 'users' in the schema cache
--
--  Car AUCUNE cle etrangere ne reliait `company_memberships` a `public.users` :
--  les deux tables designent le meme compte, mais rien ne le declarait. La
--  requete entiere etait donc refusee, et le code ignorait l'erreur en silence.
--  Resultat : zero demande affichee, pour quatre demandes reelles en base.
--
--  CE QUE CETTE MIGRATION CORRIGE
--  ------------------------------
--   1. Les cles etrangeres manquantes (rattachement -> fiche, -> entreprise,
--      fiche -> entreprise). Elles sont DEFERRABLE : `create_company()` insere
--      le rattachement avant la fiche, la verification a lieu au COMMIT.
--   2. Un rattachement fantome (aucune fiche, aucun compte d'authentification)
--      est ARCHIVE puis retire : sans cela la cle etrangere serait impossible,
--      et le cockpit afficherait une demande que personne ne peut approuver.
--   3. Les index de lecture des demandes.
--   4. Trois fonctions serveur : lister, approuver, refuser. L'approbation est
--      une SEULE transaction (rattachement actif + fiche activee + matricule),
--      la ou le navigateur enchainait deux ecritures sans lien, en affichant
--      « Demande approuvee » meme quand la premiere echouait.
--
--  RETOUR ARRIERE
--  --------------
--    BEGIN;
--    ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_user_id_fkey;
--    ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_company_id_fkey;
--    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_company_id_fkey;
--    DROP FUNCTION IF EXISTS public.list_join_requests(UUID);
--    DROP FUNCTION IF EXISTS public.approve_join_request(UUID, UUID, UUID);
--    DROP FUNCTION IF EXISTS public.reject_join_request(UUID, TEXT);
--    INSERT INTO public.company_memberships SELECT * FROM jsonb_populate_record(NULL::public.company_memberships, donnees)
--      FROM public.company_memberships_archive;   -- si l'on veut retablir la ligne archivee
--    COMMIT;
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ARCHIVAGE DU RATTACHEMENT SANS COMPTE
-- -----------------------------------------------------------------------------
--  Rien n'est perdu : la ligne complete est conservee en JSON, avec son motif.

CREATE TABLE IF NOT EXISTS public.company_memberships_archive (
    id          BIGSERIAL PRIMARY KEY,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    motif       TEXT NOT NULL,
    donnees     JSONB NOT NULL
);

ALTER TABLE public.company_memberships_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.company_memberships_archive FROM PUBLIC, anon, authenticated;

INSERT INTO public.company_memberships_archive (motif, donnees)
SELECT 'aucune fiche users ni compte d''authentification : demande inapprouvable', to_jsonb(m)
  FROM public.company_memberships m
 WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = m.user_id);

DELETE FROM public.company_memberships m
 WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = m.user_id);

-- -----------------------------------------------------------------------------
-- 2. LES CLES ETRANGERES QUI MANQUAIENT
-- -----------------------------------------------------------------------------

ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_user_id_fkey;
ALTER TABLE public.company_memberships
    ADD CONSTRAINT company_memberships_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_company_id_fkey;
ALTER TABLE public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_company_id_fkey;
ALTER TABLE public.users
    ADD CONSTRAINT users_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id)
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS company_memberships_company_status_idx
    ON public.company_memberships (company_id, status);
CREATE INDEX IF NOT EXISTS company_memberships_user_idx
    ON public.company_memberships (user_id);

-- -----------------------------------------------------------------------------
-- 3. LISTER LES DEMANDES D'UNE ENTREPRISE
-- -----------------------------------------------------------------------------
--  Une seule requete, une seule forme de reponse. Le cockpit n'assemble plus
--  lui-meme deux tables, et une liste vide signifie reellement « aucune
--  demande » — plus jamais « la requete a echoue en silence ».

CREATE OR REPLACE FUNCTION public.list_join_requests(p_company UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := p_company;
    v_lignes  JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    -- Sans entreprise precisee : celle que la personne administre.
    IF v_company IS NULL THEN
        SELECT m.company_id INTO v_company
          FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
         ORDER BY m.created_at
         LIMIT 1;
    END IF;

    IF v_company IS NULL OR NOT public.can_configure_company(v_company) THEN
        RAISE EXCEPTION 'Seuls le propriétaire et les administrateurs consultent les demandes.'
            USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id',                  m.id,
               'user_id',             m.user_id,
               'company_id',          m.company_id,
               'status',              m.status,
               'role',                lower(public.normaliser_role_membre(m.role)),
               'created_at',          m.created_at,
               'full_name',           u.full_name,
               'email',               u.email,
               'phone_number',        u.phone_number,
               'job_title',           u.job_title,
               'registration_number', u.registration_number
           ) ORDER BY m.created_at DESC), '[]'::JSONB)
      INTO v_lignes
      FROM public.company_memberships m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.company_id = v_company
       AND m.status IN ('PENDING_APPROVAL', 'INVITED');

    RETURN jsonb_build_object('ok', TRUE, 'company_id', v_company, 'requests', v_lignes);
END;
$$;

REVOKE ALL ON FUNCTION public.list_join_requests(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_join_requests(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. APPROUVER UNE DEMANDE — UNE SEULE TRANSACTION
-- -----------------------------------------------------------------------------
--  Le rattachement devient actif, la fiche est activee et rattachee a la meme
--  entreprise, et un matricule est attribue s'il en manquait un. Si une seule
--  de ces ecritures echoue, AUCUNE n'est conservee.

CREATE OR REPLACE FUNCTION public.approve_join_request(
    p_membership UUID,
    p_site       UUID DEFAULT NULL,
    p_schedule   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_demande   RECORD;
    v_prefixe   TEXT;
    v_compteur  INTEGER;
    v_matricule TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    SELECT m.id, m.user_id, m.company_id, m.status, u.registration_number, u.full_name, u.email
      INTO v_demande
      FROM public.company_memberships m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.id = p_membership
     FOR UPDATE OF m;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cette demande n''existe plus.' USING ERRCODE = 'TM404', HINT = 'DEMANDE_INTROUVABLE';
    END IF;

    IF NOT public.can_configure_company(v_demande.company_id) THEN
        RAISE EXCEPTION 'Seuls le propriétaire et les administrateurs traitent les demandes.'
            USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;

    IF v_demande.status = 'ACTIVE' THEN
        RETURN jsonb_build_object('ok', TRUE, 'status', 'ACTIVE', 'deja_traitee', TRUE,
                                  'membership_id', v_demande.id, 'user_id', v_demande.user_id,
                                  'company_id', v_demande.company_id, 'full_name', v_demande.full_name);
    END IF;

    IF v_demande.status NOT IN ('PENDING_APPROVAL', 'INVITED') THEN
        RAISE EXCEPTION 'Cette demande a déjà été traitée.' USING ERRCODE = 'TM409', HINT = 'DEMANDE_TRAITEE';
    END IF;

    -- Le site et l'horaire proposes doivent appartenir a CETTE entreprise.
    IF p_site IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.geofences g WHERE g.id = p_site AND g.company_id = v_demande.company_id
    ) THEN
        RAISE EXCEPTION 'Ce site n''appartient pas à votre entreprise.' USING ERRCODE = 'TM422', HINT = 'SITE_INVALIDE';
    END IF;

    IF p_schedule IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.work_schedules w WHERE w.id = p_schedule AND w.company_id = v_demande.company_id
    ) THEN
        RAISE EXCEPTION 'Cet horaire n''appartient pas à votre entreprise.' USING ERRCODE = 'TM422', HINT = 'HORAIRE_INVALIDE';
    END IF;

    -- Matricule : attribue ici, avec le compteur de l'entreprise verrouille.
    v_matricule := NULLIF(btrim(COALESCE(v_demande.registration_number, '')), '');
    IF v_matricule IS NULL THEN
        UPDATE public.companies
           SET employee_counter = COALESCE(employee_counter, 0) + 1,
               updated_at = NOW()
         WHERE id = v_demande.company_id
        RETURNING COALESCE(NULLIF(btrim(employee_prefix), ''), 'EMP'), employee_counter
          INTO v_prefixe, v_compteur;

        v_matricule := v_prefixe || '-' || lpad(v_compteur::TEXT, 4, '0');
    END IF;

    UPDATE public.company_memberships
       SET status = 'ACTIVE', updated_at = NOW()
     WHERE id = v_demande.id;

    UPDATE public.users
       SET is_active = TRUE,
           company_id = v_demande.company_id,
           registration_number = v_matricule,
           site_id = COALESCE(p_site, site_id),
           schedule_id = COALESCE(p_schedule, schedule_id)
     WHERE id = v_demande.user_id;

    RETURN jsonb_build_object(
        'ok', TRUE, 'status', 'ACTIVE', 'deja_traitee', FALSE,
        'membership_id', v_demande.id, 'user_id', v_demande.user_id,
        'company_id', v_demande.company_id, 'full_name', v_demande.full_name,
        'email', v_demande.email, 'registration_number', v_matricule);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_join_request(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_join_request(UUID, UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. REFUSER UNE DEMANDE — L'HISTORIQUE EST CONSERVE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_join_request(p_membership UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_demande RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    SELECT m.id, m.user_id, m.company_id, m.status, u.full_name
      INTO v_demande
      FROM public.company_memberships m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.id = p_membership
     FOR UPDATE OF m;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cette demande n''existe plus.' USING ERRCODE = 'TM404', HINT = 'DEMANDE_INTROUVABLE';
    END IF;

    IF NOT public.can_configure_company(v_demande.company_id) THEN
        RAISE EXCEPTION 'Seuls le propriétaire et les administrateurs traitent les demandes.'
            USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;

    IF v_demande.status NOT IN ('PENDING_APPROVAL', 'INVITED') THEN
        RAISE EXCEPTION 'Cette demande a déjà été traitée.' USING ERRCODE = 'TM409', HINT = 'DEMANDE_TRAITEE';
    END IF;

    -- La ligne est conservee : le refus est une trace, pas un effacement.
    UPDATE public.company_memberships
       SET status = 'REJECTED', updated_at = NOW()
     WHERE id = v_demande.id;

    UPDATE public.users
       SET is_active = FALSE
     WHERE id = v_demande.user_id
       AND NOT EXISTS (
           SELECT 1 FROM public.company_memberships m2
            WHERE m2.user_id = v_demande.user_id AND m2.status = 'ACTIVE'
       );

    RETURN jsonb_build_object('ok', TRUE, 'status', 'REJECTED',
                              'membership_id', v_demande.id, 'full_name', v_demande.full_name);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_join_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_join_request(UUID) TO authenticated;

COMMIT;

-- PostgREST garde le schema en memoire : sans ce signal, les nouvelles cles
-- etrangeres et fonctions resteraient invisibles jusqu'au prochain redemarrage.
NOTIFY pgrst, 'reload schema';
