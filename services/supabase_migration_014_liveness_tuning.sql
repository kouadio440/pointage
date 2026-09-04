-- =============================================================================
-- Winner Pointage — Migration 014 : reglages de la reconnaissance faciale
--
-- Idempotente. A executer apres la migration 013.
--
-- POURQUOI
-- --------
-- Des tests utilisateurs ont montre que des employes DEJA ENROLES n'arrivaient
-- pas a pointer. Trois causes, toutes cote reglages :
--
--   1. Le seuil de correspondance etait a 0,550 alors que le modele utilise
--      (face-api / dlib) place lui-meme sa frontiere de decision a 0,600. On
--      etait donc PLUS strict que ce que le modele recommande, pour aucun gain
--      demontre : entre 0,55 et 0,60 on ne trouve pas de visages differents,
--      on ne fait que refuser des visages legitimes mal eclaires.
--
--   2. La mesure de vivacite exigeait 10 images en 1,8 seconde. Sur un
--      telephone d'entree de gamme, la detection prend 200 a 400 ms par image :
--      le compte n'etait jamais atteint et le pointage echouait.
--
--   3. Le nombre d'images est desormais decide par le CLIENT en fonction de sa
--      vitesse (il collecte jusqu'a en avoir assez). Le plancher serveur ne
--      sert donc plus qu'a rejeter une preuve manifestement fabriquee.
--
-- CE QUI NE CHANGE PAS
-- --------------------
-- La comparaison des visages, la verification que c'est la meme personne d'un
-- bout a l'autre de la mesure, l'anti-rejeu du defi, et le refus sec en cas de
-- visage different. Aucun controle n'est retire ; on cesse seulement de
-- refuser des employes legitimes.
-- =============================================================================


-- =============================================================================
-- 1. Seuil de correspondance : 0,600, la frontiere du modele
-- =============================================================================

-- La contrainte existante n'autorise que 0,300 a 0,800 : 0,600 y entre.
UPDATE public.companies
   SET face_max_distance = 0.600
 WHERE COALESCE(face_max_distance, 0.550) < 0.600;

ALTER TABLE public.companies
    ALTER COLUMN face_max_distance SET DEFAULT 0.600;


-- =============================================================================
-- 2. Plancher d'images : garde-fou anti-fabrication, plus critere de qualite
-- =============================================================================

CREATE OR REPLACE FUNCTION public.validate_liveness(
    p_challenge_id UUID,
    p_user_id      UUID,
    p_evidence     JSONB,
    p_template     DOUBLE PRECISION[],
    p_max_distance DOUBLE PRECISION
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_ch      public.face_challenges%ROWTYPE;
    v_steps   JSONB;
    v_step    JSONB;
    v_attendu TEXT;
    v_i       INT;
    v_prev_t  NUMERIC := -1;
    v_desc    DOUBLE PRECISION[];
    v_dist    DOUBLE PRECISION;
    v_total   NUMERIC;
    v_frames  INT;
    v_deform  NUMERIC;
    v_ear     NUMERIC;
    v_descs   JSONB;

    c_blink_ratio  CONSTANT NUMERIC := 0.62;
    c_blink_base   CONSTANT NUMERIC := 0.16;
    c_yaw_min      CONSTANT NUMERIC := 0.11;
    c_mouth_min    CONSTANT NUMERIC := 0.30;
    c_step_min_ms  CONSTANT NUMERIC := 120;
    c_total_min_ms CONSTANT NUMERIC := 800;

    -- Une photographie donne un rapport voisin de 1 : les points deformables
    -- et les points rigides ne portent alors que le bruit du detecteur.
    c_deform_min   CONSTANT NUMERIC := 1.35;
    -- Un clignement naturel suffit a lui seul : il est concluant.
    c_ear_min      CONSTANT NUMERIC := 0.055;

    -- Plancher ABAISSE. Le client collecte desormais jusqu'a 14 echantillons
    -- et n'en envoie qu'a partir de 6 ; en dessous il demande un geste de
    -- lui-meme. Ce plancher ne juge donc plus la qualite de la mesure : il
    -- rejette une preuve manifestement fabriquee.
    c_pass_min_ms  CONSTANT NUMERIC := 900;
    c_pass_frames  CONSTANT INT     := 5;
BEGIN
    SELECT * INTO v_ch FROM public.face_challenges WHERE id = p_challenge_id;

    IF NOT FOUND OR v_ch.user_id <> p_user_id THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_NO_CHALLENGE',
            'detail', 'Aucun contrôle de vivacité en cours pour ce compte.');
    END IF;

    IF v_ch.consumed_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_REPLAY',
            'detail', 'Ce contrôle a déjà servi. Recommencez le pointage.');
    END IF;

    IF v_ch.expires_at < NOW() THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_EXPIRED',
            'detail', 'Le contrôle a expiré. Recommencez le pointage.');
    END IF;

    UPDATE public.face_challenges SET consumed_at = NOW() WHERE id = p_challenge_id;


    -- =====================================================================
    -- MODE PASSIF
    -- =====================================================================
    IF COALESCE(v_ch.mode, 'GESTURE') = 'PASSIVE' THEN
        v_total  := COALESCE((p_evidence ->> 'duration_ms')::numeric, 0);
        v_frames := COALESCE((p_evidence ->> 'frames')::int, 0);
        v_deform := COALESCE((p_evidence ->> 'deform_ratio')::numeric, 0);
        v_ear    := COALESCE((p_evidence ->> 'ear_range')::numeric, 0);
        v_descs  := p_evidence -> 'descriptors';

        IF v_total < c_pass_min_ms OR v_frames < c_pass_frames THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', format('Mesure trop courte pour conclure (%s images en %s ms).',
                    v_frames, round(v_total, 0)));
        END IF;

        IF v_descs IS NULL OR jsonb_typeof(v_descs) <> 'array'
           OR jsonb_array_length(v_descs) < 2 THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', 'Le visage n''a pas pu être suivi pendant la mesure.');
        END IF;

        -- Le visage doit etre le bon d'un bout a l'autre : sans cela, on
        -- pourrait se montrer soi-meme puis substituer une photographie.
        FOR v_i IN 0 .. jsonb_array_length(v_descs) - 1 LOOP
            v_desc := public.jsonb_to_descriptor(v_descs -> v_i);
            IF v_desc IS NULL OR array_length(v_desc, 1) <> 128 THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                    'detail', 'Le visage n''a pas pu être analysé pendant la mesure.');
            END IF;
            v_dist := public.face_distance(p_template, v_desc);
            IF v_dist IS NULL OR v_dist > p_max_distance THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_MISMATCH',
                    'detail', format('Le visage a changé pendant la mesure (écart %s, maximum %s).',
                        round(COALESCE(v_dist, 9)::numeric, 3), p_max_distance));
            END IF;
        END LOOP;

        IF v_deform >= c_deform_min OR v_ear >= c_ear_min THEN
            RETURN jsonb_build_object('ok', TRUE, 'mode', 'PASSIVE',
                'deform_ratio', v_deform, 'ear_range', v_ear);
        END IF;

        -- Les chiffres mesures remontent jusqu'a l'ecran : sans eux, regler
        -- les seuils se fait au jugé.
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
            'detail', format('Visage trop figé (déformation %s, minimum %s ; clignement %s, minimum %s).',
                round(v_deform, 2), c_deform_min, round(v_ear, 3), c_ear_min));
    END IF;


    -- =====================================================================
    -- MODE GESTES
    -- =====================================================================
    v_steps := p_evidence -> 'steps';
    IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
            'detail', 'Les gestes demandés n''ont pas été enregistrés.');
    END IF;

    IF jsonb_array_length(v_steps) <> array_length(v_ch.actions, 1) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
            'detail', format('%s geste(s) attendu(s), %s reçu(s).',
                array_length(v_ch.actions, 1), jsonb_array_length(v_steps)));
    END IF;

    v_total := COALESCE((p_evidence ->> 'total_ms')::numeric, 0);
    IF v_total < c_total_min_ms THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
            'detail', 'La séquence s''est déroulée trop vite pour être réelle.');
    END IF;

    FOR v_i IN 1 .. array_length(v_ch.actions, 1) LOOP
        v_attendu := v_ch.actions[v_i];
        v_step    := v_steps -> (v_i - 1);

        IF (v_step ->> 'action') IS DISTINCT FROM v_attendu THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'Les gestes n''ont pas été effectués dans l''ordre demandé.');
        END IF;

        IF COALESCE((v_step ->> 't_start')::numeric, -1) <= v_prev_t THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'La chronologie des gestes est incohérente.');
        END IF;
        IF COALESCE((v_step ->> 't_end')::numeric, 0)
           - COALESCE((v_step ->> 't_start')::numeric, 0) < c_step_min_ms THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'Un geste a été signalé trop brièvement pour être réel.');
        END IF;
        v_prev_t := (v_step ->> 't_end')::numeric;

        IF v_attendu = 'BLINK' THEN
            IF COALESCE((v_step ->> 'ear_base')::numeric, 0) < c_blink_base THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'Les yeux n''étaient pas suffisamment ouverts avant le clignement.');
            END IF;
            IF COALESCE((v_step ->> 'ear_min')::numeric, 1)
               > COALESCE((v_step ->> 'ear_base')::numeric, 0) * c_blink_ratio THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'Aucun clignement d''yeux n''a été détecté.');
            END IF;

        ELSIF v_attendu IN ('TURN_SIDE', 'TURN_LEFT', 'TURN_RIGHT') THEN
            IF abs(COALESCE((v_step ->> 'yaw_peak')::numeric, 0)) < c_yaw_min THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'La tête n''a pas assez tourné sur le côté.');
            END IF;

        ELSIF v_attendu = 'MOUTH_OPEN' THEN
            IF COALESCE((v_step ->> 'mar_peak')::numeric, 0) < c_mouth_min THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'La bouche ne s''est pas ouverte.');
            END IF;

        ELSE
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'Geste inconnu.');
        END IF;

        v_desc := public.jsonb_to_descriptor(v_step -> 'descriptor');
        IF v_desc IS NULL OR array_length(v_desc, 1) <> 128 THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'Le visage n''a pas pu être analysé pendant les gestes.');
        END IF;

        v_dist := public.face_distance(p_template, v_desc);
        IF v_dist IS NULL OR v_dist > p_max_distance THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_MISMATCH',
                'detail', format('Le visage a changé pendant le contrôle (écart %s, maximum %s).',
                    round(COALESCE(v_dist, 9)::numeric, 3), p_max_distance));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('ok', TRUE, 'mode', 'GESTURE',
        'actions', to_jsonb(v_ch.actions));
END;
$$;

REVOKE ALL ON FUNCTION public.validate_liveness(UUID, UUID, JSONB, DOUBLE PRECISION[], DOUBLE PRECISION) FROM PUBLIC;


-- =============================================================================
-- 3. Sonde de diagnostic
--
-- Mesure l'ecart entre une empreinte presentee et la reference de l'employe,
-- SANS enregistrer de pointage et SANS consommer de defi.
--
-- C'est ce qui manquait pour regler les seuils autrement qu'au jugé : on peut
-- desormais demander a un employe qui n'arrive pas a pointer de lancer le
-- diagnostic et de lire le chiffre obtenu.
--
-- L'empreinte de reference n'est jamais renvoyee : seule la DISTANCE sort.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.diagnose_face(p_descriptor DOUBLE PRECISION[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_user public.users%ROWTYPE;
    v_c    public.companies%ROWTYPE;
    v_tpl  public.face_templates%ROWTYPE;
    v_dist DOUBLE PRECISION;
    v_max  NUMERIC;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'EMPLOYEE_NOT_FOUND');
    END IF;

    SELECT * INTO v_c FROM public.companies WHERE id = v_user.company_id;
    v_max := COALESCE(v_c.face_max_distance, 0.600);

    SELECT * INTO v_tpl FROM public.face_templates WHERE user_id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_NOT_ENROLLED',
            'max_distance', v_max);
    END IF;

    IF p_descriptor IS NULL OR array_length(p_descriptor, 1) <> 128 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_DESCRIPTOR',
            'max_distance', v_max);
    END IF;

    v_dist := public.face_distance(v_tpl.descriptor, p_descriptor);

    RETURN jsonb_build_object(
        'ok', TRUE,
        'distance', round(v_dist::numeric, 4),
        'max_distance', v_max,
        'passe', (v_dist <= v_max),
        'marge', round((v_max - v_dist)::numeric, 4),
        'model_version', v_tpl.model_version,
        'enrolled_at', v_tpl.enrolled_at,
        'quality', v_tpl.quality);
END;
$$;

GRANT EXECUTE ON FUNCTION public.diagnose_face(DOUBLE PRECISION[]) TO authenticated;
