-- =============================================================================
--  MIGRATION 032 — AVIS DES UTILISATEURS (vrais avis, moderes)
-- =============================================================================
--
--  La page d'accueil affichait quatre « temoignages » ecrits a la main, avec
--  des photos de banque d'images, ajoutes avant meme que la premiere
--  entreprise n'existe. Ils ont ete retires. Cette migration pose un vrai
--  systeme :
--
--    - un utilisateur connecte (adresse e-mail verifiee) depose UN avis :
--      note 1 a 5, titre facultatif, texte ;
--    - l'avis est EN ATTENTE jusqu'a sa validation par l'equipe Timora ;
--    - seuls les avis APPROUVES sont publics ; la note moyenne n'est calculee
--      qu'a partir d'eux, et n'est affichee qu'a partir de 3 avis ;
--    - la mention « Client Timora » n'est posee que si le serveur verifie que
--      l'auteur appartient a une entreprise reellement cliente (production :
--      entreprise historique, paiement confirme ou activation par la
--      plateforme) ;
--    - anti-abus : texte nettoye (balises retirees), liens et adresses e-mail
--      refuses, repetitions refusees, un avis par compte, une modification
--      toutes les 10 minutes, doublons entre comptes refuses.
--
--  Aucune donnee n'est lue ni ecrite directement par le navigateur : tout
--  passe par les fonctions ci-dessous (SECURITY DEFINER).
--
--  Depend de la migration 031 (colonnes de facturation des entreprises).
--  Retour arriere : services/supabase_migration_032_avis_retour.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.reviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id        UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title             TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 3 AND 80),
    body              TEXT NOT NULL CHECK (char_length(body) BETWEEN 20 AND 1000),
    author_name       TEXT CHECK (author_name IS NULL OR char_length(author_name) BETWEEN 1 AND 80),
    company_name      TEXT,
    show_company      BOOLEAN NOT NULL DEFAULT FALSE,
    verified_customer BOOLEAN NOT NULL DEFAULT FALSE,
    status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    body_hash         TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    moderated_at      TIMESTAMPTZ,
    moderated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT reviews_un_par_compte UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS reviews_publies_idx ON public.reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_empreinte_idx ON public.reviews (body_hash);

-- Aucun acces direct : lecture et ecriture par les fonctions seulement.
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reviews FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Outils
-- -----------------------------------------------------------------------------

/** Texte brut : balises retirees, caracteres de controle retires, espaces normalises. */
CREATE OR REPLACE FUNCTION public.avis_nettoyer(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT NULLIF(btrim(
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    regexp_replace(COALESCE(p, ''), '<[^>]*>', ' ', 'g'),
                    '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'),
                '[ \t]+', ' ', 'g'),
            '\n{3,}', E'\n\n', 'g')), '');
$$;

/** « Awa Koné » -> « Awa K. » : jamais le nom complet en public. */
CREATE OR REPLACE FUNCTION public.avis_nom_public(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p IS NULL OR btrim(p) = '' THEN 'Utilisateur Timora'
        WHEN array_length(m, 1) >= 2 THEN initcap(m[1]) || ' ' || upper(left(m[2], 1)) || '.'
        ELSE initcap(m[1])
    END
    FROM (SELECT regexp_split_to_array(btrim(COALESCE(p, '')), '\s+') AS m) x;
$$;

/**
 * L'entreprise est-elle reellement cliente ? Production uniquement : entreprise
 * historique, paiement confirme, ou abonnement active par la plateforme. Un
 * paiement de test (sandbox) ne fait pas un client.
 */
CREATE OR REPLACE FUNCTION public.avis_client_reel(p_company UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.companies c
         WHERE c.id = p_company
           AND c.billing_environment = 'production'
           AND (c.billing_legacy
                OR EXISTS (SELECT 1 FROM public.billing_payments p
                            WHERE p.company_id = c.id AND p.status = 'COMPLETED' AND p.environment = 'production')
                OR EXISTS (SELECT 1 FROM public.company_subscriptions s
                            WHERE s.company_id = c.id AND s.environment = 'production'
                              AND s.provider IN ('JOONAPAY', 'MANUAL')
                              AND s.status IN ('ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED')))
    );
$$;

REVOKE ALL ON FUNCTION public.avis_client_reel(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Lecture publique : avis approuves seulement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reviews_public(p_limit INT DEFAULT 12)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH approuves AS (
        SELECT * FROM public.reviews WHERE status = 'APPROVED'
    ), stats AS (
        SELECT count(*)::INT AS nombre, round(avg(rating)::NUMERIC, 1) AS moyenne FROM approuves
    )
    SELECT jsonb_build_object(
        'nombre',  s.nombre,
        -- La moyenne n'a de sens qu'a partir de quelques avis.
        'moyenne', CASE WHEN s.nombre >= 3 THEN s.moyenne END,
        'avis',    COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id',             a.id,
                       'auteur',         public.avis_nom_public(a.author_name),
                       'entreprise',     CASE WHEN a.show_company AND a.verified_customer THEN a.company_name END,
                       'note',           a.rating,
                       'titre',          a.title,
                       'texte',          a.body,
                       'date',           a.created_at,
                       'client_verifie', a.verified_customer
                   ) ORDER BY a.created_at DESC)
              FROM (SELECT * FROM approuves ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 12), 1), 30)) a
        ), '[]'::JSONB)
    )
    FROM stats s;
$$;

REVOKE ALL ON FUNCTION public.reviews_public(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reviews_public(INT) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- Deposer (ou modifier) son avis
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_review(
    p_rating       INT,
    p_title        TEXT DEFAULT NULL,
    p_body         TEXT DEFAULT NULL,
    p_show_company BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_email   TEXT := auth.email();
    v_titre   TEXT;
    v_texte   TEXT;
    v_hash    TEXT;
    v_nom     TEXT;
    v_avant   RECORD;
    v_ent     RECORD;
    v_client  BOOLEAN := FALSE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Connectez-vous pour donner votre avis.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.compte_email_verifie() THEN
        RAISE EXCEPTION 'Confirmez votre adresse e-mail avant de publier un avis.'
            USING ERRCODE = 'TM401', HINT = 'EMAIL_NON_VERIFIE';
    END IF;
    IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'Choisissez une note de 1 à 5 étoiles.' USING ERRCODE = 'TM422', HINT = 'NOTE_INVALIDE';
    END IF;

    v_titre := regexp_replace(public.avis_nettoyer(p_title), '\s+', ' ', 'g');
    v_texte := public.avis_nettoyer(p_body);

    IF v_titre IS NOT NULL AND char_length(v_titre) NOT BETWEEN 3 AND 80 THEN
        RAISE EXCEPTION 'Le titre doit faire entre 3 et 80 caractères.' USING ERRCODE = 'TM422', HINT = 'TITRE_INVALIDE';
    END IF;
    IF v_texte IS NULL OR char_length(v_texte) < 20 THEN
        RAISE EXCEPTION 'Votre avis doit faire au moins 20 caractères.' USING ERRCODE = 'TM422', HINT = 'AVIS_TROP_COURT';
    END IF;
    IF char_length(v_texte) > 1000 THEN
        RAISE EXCEPTION 'Votre avis ne peut pas dépasser 1 000 caractères.' USING ERRCODE = 'TM422', HINT = 'AVIS_TROP_LONG';
    END IF;
    -- Liens et adresses : premier vecteur de spam et de liens malveillants.
    IF concat_ws(' ', v_titre, v_texte) ~* '(https?://|www\.|[a-z0-9-]+\.(com|net|org|info|biz|xyz|io|co|ci|fr|sn|me|link|click|top|ru|cn|app|site|online|shop)([/?#]|\s|$)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})' THEN
        RAISE EXCEPTION 'Les liens et les adresses e-mail ne sont pas autorisés dans un avis.'
            USING ERRCODE = 'TM422', HINT = 'LIENS_INTERDITS';
    END IF;
    IF v_texte ~ '(.)\1{9,}' THEN
        RAISE EXCEPTION 'Votre avis contient une répétition de caractères.' USING ERRCODE = 'TM422', HINT = 'AVIS_INVALIDE';
    END IF;

    v_hash := md5(lower(regexp_replace(v_texte, '[^[:alnum:]]+', '', 'g')));

    -- Un compte, un avis ; une modification toutes les 10 minutes.
    PERFORM pg_advisory_xact_lock(hashtextextended('avis:' || v_uid::TEXT, 0));
    SELECT id, updated_at INTO v_avant FROM public.reviews WHERE user_id = v_uid FOR UPDATE;
    IF FOUND AND v_avant.updated_at > NOW() - INTERVAL '10 minutes' THEN
        RAISE EXCEPTION 'Vous venez déjà d''envoyer votre avis. Vous pourrez le modifier dans quelques minutes.'
            USING ERRCODE = 'TM429', HINT = 'TROP_RAPIDE';
    END IF;
    IF EXISTS (SELECT 1 FROM public.reviews r WHERE r.body_hash = v_hash AND r.user_id <> v_uid) THEN
        RAISE EXCEPTION 'Cet avis a déjà été déposé par un autre compte.' USING ERRCODE = 'TM409', HINT = 'AVIS_EN_DOUBLE';
    END IF;
    -- Garde-fou global contre une vague de comptes automatiques.
    IF (SELECT count(*) FROM public.reviews WHERE created_at > NOW() - INTERVAL '1 hour') >= 50 THEN
        RAISE EXCEPTION 'Trop d''avis ont été déposés récemment. Réessayez un peu plus tard.'
            USING ERRCODE = 'TM429', HINT = 'TROP_D_AVIS';
    END IF;

    -- Nom affiche : celui du compte, jamais la partie locale de l'adresse
    -- e-mail (qui l'identifierait).
    v_nom := public.nom_compte_connecte();
    IF v_nom IS NULL OR lower(btrim(v_nom)) = lower(split_part(COALESCE(v_email, ''), '@', 1)) THEN
        v_nom := NULL;
    END IF;

    SELECT c.id, c.name INTO v_ent
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_uid AND m.status = 'ACTIVE'
     ORDER BY (public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')) DESC, m.created_at
     LIMIT 1;
    IF v_ent.id IS NOT NULL THEN
        v_client := public.avis_client_reel(v_ent.id);
    END IF;

    INSERT INTO public.reviews (user_id, company_id, rating, title, body, author_name, company_name,
                                show_company, verified_customer, status, body_hash)
    VALUES (v_uid, v_ent.id, p_rating, v_titre, v_texte, left(v_nom, 80), v_ent.name,
            COALESCE(p_show_company, FALSE) AND v_client, v_client, 'PENDING', v_hash)
    ON CONFLICT (user_id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            rating = EXCLUDED.rating,
            title = EXCLUDED.title,
            body = EXCLUDED.body,
            author_name = EXCLUDED.author_name,
            company_name = EXCLUDED.company_name,
            show_company = EXCLUDED.show_company,
            verified_customer = EXCLUDED.verified_customer,
            body_hash = EXCLUDED.body_hash,
            -- Toute modification repasse par la moderation.
            status = 'PENDING',
            moderated_at = NULL,
            moderated_by = NULL,
            updated_at = NOW();

    RETURN jsonb_build_object('ok', TRUE, 'status', 'PENDING', 'client_verifie', v_client);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_review(INT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_review(INT, TEXT, TEXT, BOOLEAN) TO authenticated;

/** Son propre avis (pour pre-remplir le formulaire) et ce qu'on peut afficher. */
CREATE OR REPLACE FUNCTION public.my_review()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_r   RECORD;
    v_ent RECORD;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_r FROM public.reviews WHERE user_id = v_uid;

    SELECT c.id, c.name INTO v_ent
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_uid AND m.status = 'ACTIVE'
     ORDER BY (public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')) DESC, m.created_at
     LIMIT 1;

    RETURN jsonb_build_object(
        'avis', CASE WHEN v_r.id IS NULL THEN NULL ELSE jsonb_build_object(
            'note', v_r.rating, 'titre', v_r.title, 'texte', v_r.body,
            'afficher_entreprise', v_r.show_company, 'statut', v_r.status,
            'modifie_le', v_r.updated_at) END,
        -- Le nom de l'entreprise n'est proposable que pour un vrai client.
        'entreprise', CASE WHEN v_ent.id IS NOT NULL AND public.avis_client_reel(v_ent.id) THEN v_ent.name END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_review() TO authenticated;

-- -----------------------------------------------------------------------------
-- Moderation (administrateurs de la plateforme)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reviews_moderation_list(p_statut TEXT DEFAULT 'PENDING')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.' USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object(
        'compteurs', (SELECT jsonb_build_object(
                          'PENDING',  count(*) FILTER (WHERE status = 'PENDING'),
                          'APPROVED', count(*) FILTER (WHERE status = 'APPROVED'),
                          'REJECTED', count(*) FILTER (WHERE status = 'REJECTED'))
                        FROM public.reviews),
        'avis', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id,
                       'auteur', public.avis_nom_public(r.author_name),
                       'email', u.email,
                       'entreprise', r.company_name,
                       'afficher_entreprise', r.show_company,
                       'client_verifie', r.verified_customer,
                       'note', r.rating,
                       'titre', r.title,
                       'texte', r.body,
                       'statut', r.status,
                       'date', r.updated_at
                   ) ORDER BY r.updated_at DESC)
              FROM public.reviews r
              LEFT JOIN auth.users u ON u.id = r.user_id
             WHERE r.status = upper(COALESCE(p_statut, 'PENDING'))
        ), '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reviews_moderation_list(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reviews_moderation_list(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.moderate_review(p_id UUID, p_decision TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_decision TEXT := upper(btrim(COALESCE(p_decision, '')));
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.' USING ERRCODE = '42501';
    END IF;
    IF v_decision NOT IN ('APPROVED', 'REJECTED') THEN
        RAISE EXCEPTION 'Décision invalide.' USING ERRCODE = 'TM422', HINT = 'DECISION_INVALIDE';
    END IF;

    UPDATE public.reviews
       SET status = v_decision, moderated_at = NOW(), moderated_by = auth.uid()
     WHERE id = p_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Avis introuvable.' USING ERRCODE = 'TM404', HINT = 'AVIS_INTROUVABLE';
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'statut', v_decision);
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_review(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_review(UUID, TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
