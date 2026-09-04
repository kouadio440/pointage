-- =============================================================================
-- Winner Pointage — Migration 015 : planchers adaptes a la capture photo
--
-- Idempotente. A executer apres la migration 014.
--
-- POURQUOI
-- --------
-- Le client n'analyse plus le flux video. Il prend QUATRE cliches espaces de
-- 400 ms, puis n'execute le modele que sur ces quatre images : quatre passages
-- au lieu de quatorze. Sur un telephone d'entree de gamme, le pointage passe
-- d'environ six secondes a moins de deux.
--
-- Les planchers de la migration 014 (cinq images, 900 ms) etaient calibres sur
-- l'ancienne mesure video et refuseraient desormais toute preuve legitime.
--
-- CE QUE CES PLANCHERS SONT, ET NE SONT PAS
-- -----------------------------------------
-- Ce ne sont PAS des criteres de qualite : c'est le client qui juge s'il a
-- assez d'echantillons, et qui demande un geste sinon. Ils servent uniquement
-- a rejeter une preuve manifestement fabriquee — quelqu'un qui enverrait
-- « une image en zero milliseconde ».
--
-- CE QUI FAIBLIT, ET IL FAUT LE DIRE
-- ----------------------------------
-- La dispersion est desormais estimee sur quatre echantillons au lieu d'une
-- douzaine. L'estimation est donc plus bruitee, et le signal anti-photo plus
-- faible qu'auparavant. Il n'est pas supprime : une photographie brandie reste
-- rigide d'un cliche a l'autre, et les deux empreintes prouvent toujours que
-- c'est le meme visage du premier au dernier cliche.
--
-- Les entreprises qui veulent davantage disposent du mode GESTURE, qui impose
-- des gestes tires au sort a chaque pointage.
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

    c_deform_min   CONSTANT NUMERIC := 1.35;
    c_ear_min      CONSTANT NUMERIC := 0.055;

    -- Quatre cliches espaces de 400 ms : la sequence dure au moins 1,2 s de
    -- prise, plus l'analyse. Un plancher de 600 ms laisse la marge d'un
    -- appareil qui ecourterait legerement, tout en rejetant l'instantane.
    c_pass_min_ms  CONSTANT NUMERIC := 600;
    -- Le client vise quatre cliches et n'en envoie qu'a partir de trois
    -- exploitables ; en dessous il demande un geste de lui-meme.
    c_pass_frames  CONSTANT INT     := 3;
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
    -- MODE PASSIF — quelques cliches
    -- =====================================================================
    IF COALESCE(v_ch.mode, 'GESTURE') = 'PASSIVE' THEN
        v_total  := COALESCE((p_evidence ->> 'duration_ms')::numeric, 0);
        v_frames := COALESCE((p_evidence ->> 'frames')::int, 0);
        v_deform := COALESCE((p_evidence ->> 'deform_ratio')::numeric, 0);
        v_ear    := COALESCE((p_evidence ->> 'ear_range')::numeric, 0);
        v_descs  := p_evidence -> 'descriptors';

        IF v_total < c_pass_min_ms OR v_frames < c_pass_frames THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', format('Mesure trop courte pour conclure (%s clichés en %s ms).',
                    v_frames, round(v_total, 0)));
        END IF;

        IF v_descs IS NULL OR jsonb_typeof(v_descs) <> 'array'
           OR jsonb_array_length(v_descs) < 2 THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', 'Le visage n''a pas pu être suivi d''un cliché à l''autre.');
        END IF;

        -- Le visage doit etre le bon du PREMIER au DERNIER cliche : sans cela,
        -- on pourrait se montrer soi-meme puis substituer une photographie.
        FOR v_i IN 0 .. jsonb_array_length(v_descs) - 1 LOOP
            v_desc := public.jsonb_to_descriptor(v_descs -> v_i);
            IF v_desc IS NULL OR array_length(v_desc, 1) <> 128 THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                    'detail', 'Le visage n''a pas pu être analysé sur ces clichés.');
            END IF;
            v_dist := public.face_distance(p_template, v_desc);
            IF v_dist IS NULL OR v_dist > p_max_distance THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_MISMATCH',
                    'detail', format('Le visage a changé entre les clichés (écart %s, maximum %s).',
                        round(COALESCE(v_dist, 9)::numeric, 3), p_max_distance));
            END IF;
        END LOOP;

        IF v_deform >= c_deform_min OR v_ear >= c_ear_min THEN
            RETURN jsonb_build_object('ok', TRUE, 'mode', 'PASSIVE',
                'deform_ratio', v_deform, 'ear_range', v_ear);
        END IF;

        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
            'detail', format('Visage trop figé entre les clichés (déformation %s, minimum %s ; clignement %s, minimum %s).',
                round(v_deform, 2), c_deform_min, round(v_ear, 3), c_ear_min));
    END IF;


    -- =====================================================================
    -- MODE GESTES — inchange
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
