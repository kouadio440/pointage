-- =============================================================================
-- Winner Pointage — Migration 009 : reconnaissance faciale
--
-- Idempotente. A executer apres les migrations precedentes.
--
-- PRINCIPE DE SECURITE
-- --------------------
-- Le modele de reconnaissance tourne dans le navigateur (il n'y a pas de
-- serveur d'inference dans cette architecture). Si le navigateur calculait un
-- SCORE et l'envoyait, un client modifie enverrait « score = 99 » et le
-- controle ne vaudrait rien.
--
-- Le partage est donc le suivant :
--   - le navigateur calcule l'EMPREINTE (128 nombres) et la transmet ;
--   - le SERVEUR calcule la distance avec l'empreinte de reference et decide.
--
-- Le client transmet une mesure, jamais un verdict. Pour forger une empreinte
-- passante, il faudrait connaitre celle de la victime : elle est stockee ici,
-- aucune politique RLS ne permet de la lire, et aucune fonction ne la renvoie.
--
-- CE QUE CE DISPOSITIF NE FAIT PAS
-- --------------------------------
-- Il ne detecte PAS une photographie presentee devant la camera. Un test de
-- vivacite (liveness) exige soit un capteur de profondeur, soit un modele
-- dedie. Un signal de mouvement faible est calcule et remonte pour revue
-- humaine, mais il n'est jamais presente comme une preuve d'anti-usurpation.
-- =============================================================================


-- =============================================================================
-- 1. Empreintes de reference
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.face_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL UNIQUE,

    -- Vecteur de 128 flottants produit par le modele. Ce n'est PAS une photo :
    -- on ne peut pas reconstituer un visage a partir de ces nombres.
    descriptor DOUBLE PRECISION[] NOT NULL,

    -- Un changement de modele rend les vecteurs incomparables : il impose un
    -- reenrolement. On garde donc la version qui a produit l'empreinte.
    model_version TEXT NOT NULL DEFAULT 'face-api-1.7.15/128',

    -- Qualite de la capture de reference (nettete, pose). Sert a expliquer un
    -- taux d'echec eleve chez un employe donne.
    quality NUMERIC(5,2),

    -- Consentement biometrique : revocable, et sa revocation ne doit jamais
    -- empecher l'employe de travailler (il repasse en GPS + selfie simple).
    consent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT face_templates_descriptor_size CHECK (array_length(descriptor, 1) = 128)
);

CREATE INDEX IF NOT EXISTS idx_face_templates_company
    ON public.face_templates (company_id);

ALTER TABLE public.face_templates ENABLE ROW LEVEL SECURITY;

-- AUCUNE politique. Ni lecture, ni ecriture, pour personne.
-- Seules les fonctions SECURITY DEFINER ci-dessous accedent a cette table.
-- Exposer les empreintes permettrait de forger un pointage passant.
DROP POLICY IF EXISTS "Public & Anon access on face_templates" ON public.face_templates;


-- =============================================================================
-- 2. Reglages par entreprise
--
-- La distance euclidienne est l'unite naturelle du modele : deux captures d'une
-- meme personne tombent typiquement entre 0,30 et 0,50 ; deux personnes
-- differentes au-dela de 0,70. On expose donc un seuil de DISTANCE, plus
-- honnete qu'un pourcentage invente.
-- =============================================================================

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS face_max_distance NUMERIC(4,3) DEFAULT 0.550,
    -- Sous ce seuil de mouvement entre les prises, la capture est marquee pour
    -- revue : c'est le comportement d'une photo tenue devant l'objectif.
    ADD COLUMN IF NOT EXISTS face_min_motion NUMERIC(5,4) DEFAULT 0.0000;

ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_face_distance_sane;
ALTER TABLE public.companies
    ADD CONSTRAINT companies_face_distance_sane
    CHECK (face_max_distance BETWEEN 0.300 AND 0.800);


-- =============================================================================
-- 3. Distance euclidienne entre deux empreintes
-- =============================================================================

CREATE OR REPLACE FUNCTION public.face_distance(a DOUBLE PRECISION[], b DOUBLE PRECISION[])
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    s DOUBLE PRECISION := 0;
    i INT;
BEGIN
    IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
    IF array_length(a, 1) <> array_length(b, 1) THEN RETURN NULL; END IF;

    FOR i IN 1..array_length(a, 1) LOOP
        s := s + (a[i] - b[i]) ^ 2;
    END LOOP;

    RETURN sqrt(s);
END;
$$;

REVOKE ALL ON FUNCTION public.face_distance(DOUBLE PRECISION[], DOUBLE PRECISION[]) FROM PUBLIC;


-- =============================================================================
-- 4. Enrolement — l'employe enregistre son visage de reference
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enroll_face(
    p_descriptor    DOUBLE PRECISION[],
    p_quality       NUMERIC DEFAULT NULL,
    p_model_version TEXT DEFAULT 'face-api-1.7.15/128'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_user public.users%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'EMPLOYEE_NOT_FOUND',
            'message', 'Votre fiche employé est introuvable.');
    END IF;

    IF p_descriptor IS NULL OR array_length(p_descriptor, 1) <> 128 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_DESCRIPTOR',
            'message', 'La capture n''a pas produit une empreinte exploitable.');
    END IF;

    INSERT INTO public.face_templates (company_id, user_id, descriptor, model_version, quality)
    VALUES (v_user.company_id, v_user.id, p_descriptor, p_model_version, p_quality)
    ON CONFLICT (user_id) DO UPDATE
        SET descriptor    = EXCLUDED.descriptor,
            model_version = EXCLUDED.model_version,
            quality       = EXCLUDED.quality,
            company_id    = EXCLUDED.company_id,
            consent_at    = NOW(),
            updated_at    = NOW();

    RETURN jsonb_build_object('ok', TRUE,
        'message', 'Votre visage de référence est enregistré.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.enroll_face(DOUBLE PRECISION[], NUMERIC, TEXT) TO authenticated;


-- =============================================================================
-- 5. Etat d'enrolement — sans jamais renvoyer l'empreinte
-- =============================================================================

CREATE OR REPLACE FUNCTION public.my_face_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_t   public.face_templates%ROWTYPE;
    v_c   public.companies%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('enrolled', FALSE, 'code', 'NOT_AUTHENTICATED');
    END IF;

    SELECT c.* INTO v_c FROM public.companies c
      JOIN public.users u ON u.company_id = c.id WHERE u.id = v_uid;

    SELECT * INTO v_t FROM public.face_templates WHERE user_id = v_uid;

    RETURN jsonb_build_object(
        'enrolled',      FOUND,
        'enrolled_at',   v_t.enrolled_at,
        'model_version', v_t.model_version,
        'quality',       v_t.quality,
        'required',      COALESCE(v_c.face_verification_enabled, FALSE),
        'max_distance',  COALESCE(v_c.face_max_distance, 0.550),
        -- Le client doit savoir s'il faut demander un défi de vivacité AVANT
        -- de pointer : sans défi, record_attendance refuse LIVENESS_REQUIRED.
        'liveness',      COALESCE(v_c.face_verification_enabled, FALSE)
                         AND COALESCE(v_c.face_liveness_enabled, TRUE)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_face_status() TO authenticated;


-- =============================================================================
-- 6. Revocation du consentement biometrique
--
-- Doit rester possible a tout moment, et ne jamais empecher de travailler :
-- l'employe repasse simplement en GPS + selfie conserve comme preuve. Un
-- consentement qu'on ne peut pas retirer n'est pas un consentement.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.revoke_my_face()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED');
    END IF;

    DELETE FROM public.face_templates WHERE user_id = auth.uid();

    RETURN jsonb_build_object('ok', TRUE,
        'message', 'Votre empreinte faciale a été supprimée définitivement.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_my_face() TO authenticated;


-- =============================================================================
-- 7. Etat d'enrolement de l'effectif — vue RH, sans aucune empreinte
-- =============================================================================

-- L'entreprise consultee est passee en parametre, et non deduite de
-- users.company_id : la source de verite du rattachement est
-- company_memberships (migration 004). Un CEO qui gere plusieurs entreprises,
-- ou dont users.company_id a derive, verrait sinon la liste d'une autre.
-- L'habilitation reste verifiee par can_view_company_attendance().
DROP FUNCTION IF EXISTS public.company_face_enrollment();

CREATE OR REPLACE FUNCTION public.company_face_enrollment(p_company_id UUID DEFAULT NULL)
RETURNS TABLE (user_id UUID, full_name TEXT, matricule TEXT, enrolled BOOLEAN, enrolled_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := p_company_id;
    IF v_company IS NULL THEN
        SELECT u.company_id INTO v_company FROM public.users u WHERE u.id = auth.uid();
    END IF;

    IF v_company IS NULL OR NOT public.can_view_company_attendance(v_company) THEN
        RETURN;
    END IF;

    -- L'effectif est celui que le Cockpit RH affiche : rattachement direct
    -- (users.company_id) OU rattachement par company_memberships. S'en tenir a
    -- la premiere colonne ferait disparaitre de la liste des employes que le
    -- tableau de preparation, lui, affiche — un ecart de comptage que le RH
    -- n'aurait aucun moyen d'expliquer.
    RETURN QUERY
    SELECT u.id, u.full_name::TEXT, u.registration_number::TEXT,
           (t.id IS NOT NULL), t.enrolled_at
      FROM public.users u
      LEFT JOIN public.face_templates t ON t.user_id = u.id
     WHERE u.company_id = v_company
        OR EXISTS (SELECT 1 FROM public.company_memberships m
                    WHERE m.user_id = u.id AND m.company_id = v_company)
     ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.company_face_enrollment(UUID) TO authenticated;
