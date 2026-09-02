-- =============================================================================
-- Winner Pointage — Migration 012 : vivacite PASSIVE
--
-- Idempotente. A executer apres la migration 011.
--
-- LE PROBLEME QU ELLE RESOUT
-- --------------------------
-- La migration 011 imposait deux gestes A CHAQUE POINTAGE. C etait sur, mais
-- inutilisable : personne n accepte de tourner la tete et d ouvrir la bouche
-- deux fois par jour, tous les jours. Un controle que les gens contournent ou
-- abandonnent ne protege rien.
--
-- Le modele juste est celui du deverrouillage facial d un telephone : on
-- travaille A L ENROLEMENT, puis on ne demande plus rien.
--
-- LE PRINCIPE DE LA MESURE PASSIVE
-- --------------------------------
-- L employe regarde simplement la camera pendant environ trois secondes. Le
-- navigateur mesure la maniere dont le visage se deforme, et le serveur decide.
--
-- Ce qui distingue un visage d une photographie n est pas le MOUVEMENT — une
-- photo tenue a la main bouge aussi — mais la RIGIDITE. Une photographie est
-- une forme rigide : une fois recalee sur la ligne des yeux, ses points ne
-- bougent plus les uns par rapport aux autres. Un visage vivant se deforme en
-- permanence et INEGALEMENT : les paupieres et la bouche bougent beaucoup plus
-- que l arete du nez.
--
-- On mesure donc un RAPPORT : dispersion des points deformables (paupieres,
-- levres) divisee par celle des points rigides (arete du nez, coins externes
-- des yeux). Sur une photographie, les deux ne contiennent que le bruit du
-- detecteur : le rapport vaut environ 1. Sur un visage vivant, il depasse
-- nettement 1. Ce rapport est insensible a l echelle, a la rotation et aux
-- tremblements de la main, precisement parce qu il compare deux bruits issus
-- de la meme image.
--
-- QUAND LA MESURE EST INDECISE
-- ----------------------------
-- On ne refuse pas : on demande UN geste. Un employe tres immobile, une
-- camera de mauvaise qualite ou un eclairage difficile ne doivent jamais
-- empecher quelqu un de pointer. Le refus sec est reserve au visage qui ne
-- correspond pas.
--
-- CE QUE CELA NE FAIT TOUJOURS PAS
-- --------------------------------
-- Les mesures viennent du navigateur. Quelqu un qui modifie l application peut
-- les fabriquer. Ce dispositif arrete la photographie brandie, pas un
-- attaquant outille. Voir l en-tete de la migration 011.
-- =============================================================================


-- =============================================================================
-- 1. Mode de controle, par entreprise
-- =============================================================================

ALTER TABLE public.companies
    -- PASSIVE : rien n est demande, sauf si la mesure est indecise.
    -- GESTURE : les gestes sont imposes a chaque pointage (maximum de surete,
    --           minimum de confort — a reserver aux sites tres exposes).
    ADD COLUMN IF NOT EXISTS face_liveness_mode TEXT DEFAULT 'PASSIVE';

ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_liveness_mode_sane;
ALTER TABLE public.companies
    ADD CONSTRAINT companies_liveness_mode_sane
    CHECK (face_liveness_mode IN ('PASSIVE', 'GESTURE'));

-- Les entreprises deja configurees passent en mode passif : c est le reglage
-- que l usage impose, et le mode geste reste accessible d un clic.
UPDATE public.companies SET face_liveness_mode = 'PASSIVE' WHERE face_liveness_mode IS NULL;


-- =============================================================================
-- 2. Le defi porte desormais un mode
-- =============================================================================

ALTER TABLE public.face_challenges
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'GESTURE';

-- Un defi passif n impose aucun geste : la colonne doit accepter le tableau vide.
ALTER TABLE public.face_challenges ALTER COLUMN actions DROP NOT NULL;


-- =============================================================================
-- 3. Emission — passive par defaut, gestes sur demande
--
-- `p_mode` vient du client, mais il n affaiblit RIEN : demander un defi passif
-- alors que l entreprise exige les gestes est refuse ci-dessous. Le client peut
-- seulement demander PLUS strict que le reglage, jamais moins.
-- =============================================================================

DROP FUNCTION IF EXISTS public.issue_face_challenge();

CREATE OR REPLACE FUNCTION public.issue_face_challenge(p_mode TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_user    public.users%ROWTYPE;
    v_company public.companies%ROWTYPE;
    v_pool    TEXT[] := ARRAY['BLINK', 'MOUTH_OPEN', 'TURN_SIDE'];
    v_actions TEXT[] := ARRAY[]::TEXT[];
    v_mode    TEXT;
    v_n       INT;
    v_i       INT;
    v_j       INT;
    v_tmp     TEXT;
    v_id      UUID;
    v_ttl     INT := 90;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'EMPLOYEE_NOT_FOUND');
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;

    -- Le reglage de l entreprise plafonne le confort : si elle exige les
    -- gestes, un client qui demande le mode passif obtient quand meme les
    -- gestes. L inverse est autorise (le client peut durcir).
    IF COALESCE(v_company.face_liveness_mode, 'PASSIVE') = 'GESTURE' THEN
        v_mode := 'GESTURE';
    ELSE
        v_mode := CASE WHEN upper(COALESCE(p_mode, 'PASSIVE')) = 'GESTURE'
                       THEN 'GESTURE' ELSE 'PASSIVE' END;
    END IF;

    IF v_mode = 'GESTURE' THEN
        v_n := LEAST(array_length(v_pool, 1),
                     GREATEST(1, COALESCE(v_company.face_liveness_steps, 2)));

        -- Melange de Fisher-Yates ecrit a la main : « ORDER BY random() » dans
        -- un sous-select est evalue une seule fois par le planificateur, ce qui
        -- rendait le defi identique a chaque pointage (voir migration 011).
        v_actions := v_pool;
        FOR v_i IN REVERSE array_length(v_actions, 1) .. 2 LOOP
            v_j := 1 + floor(random() * v_i)::int;
            v_tmp          := v_actions[v_i];
            v_actions[v_i] := v_actions[v_j];
            v_actions[v_j] := v_tmp;
        END LOOP;
        v_actions := v_actions[1:v_n];
    END IF;

    -- Un seul defi vivant a la fois : sinon on pourrait en collectionner et
    -- choisir le plus commode.
    UPDATE public.face_challenges
       SET consumed_at = NOW()
     WHERE user_id = v_uid AND consumed_at IS NULL;

    INSERT INTO public.face_challenges (user_id, company_id, actions, mode, expires_at)
    VALUES (v_uid, v_user.company_id, v_actions, v_mode,
            NOW() + make_interval(secs => v_ttl))
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'challenge_id', v_id,
        'mode', v_mode,
        'actions', to_jsonb(COALESCE(v_actions, ARRAY[]::TEXT[])),
        'expires_in', v_ttl);
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_face_challenge(TEXT) TO authenticated;


-- =============================================================================
-- 4. Validation, passive ou par gestes
--
-- Preuve PASSIVE attendue :
--   { "mode": "PASSIVE",
--     "duration_ms": 3100, "frames": 24,
--     "deform_ratio": 2.6,     -- dispersion deformable / dispersion rigide
--     "ear_range": 0.13,       -- amplitude du rapport d aspect des yeux
--     "yaw_range": 0.05,
--     "descriptors": [ [...128], [...128], [...128] ] }
--
-- Les seuils vivent ici, cote serveur, et nulle part ailleurs.
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

    -- --- Seuils du mode passif ---------------------------------------------
    -- Une photographie donne un rapport voisin de 1 : les points deformables
    -- et les points rigides ne portent alors que le bruit du detecteur. On
    -- exige une marge nette au-dessus, sans exces : le refus n est pas un
    -- blocage, il declenche une demande de geste.
    c_deform_min   CONSTANT NUMERIC := 1.35;
    -- Un clignement naturel suffit a lui seul : il est concluant.
    c_ear_min      CONSTANT NUMERIC := 0.055;
    -- Une fenetre trop courte ou trop pauvre en images ne mesure rien.
    c_pass_min_ms  CONSTANT NUMERIC := 1800;
    c_pass_frames  CONSTANT INT     := 10;
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

    -- Consomme immediatement : meme en cas d echec, ce defi ne resservira pas.
    UPDATE public.face_challenges SET consumed_at = NOW() WHERE id = p_challenge_id;


    -- =====================================================================
    -- 4.a MODE PASSIF
    -- =====================================================================
    IF COALESCE(v_ch.mode, 'GESTURE') = 'PASSIVE' THEN
        v_total  := COALESCE((p_evidence ->> 'duration_ms')::numeric, 0);
        v_frames := COALESCE((p_evidence ->> 'frames')::int, 0);
        v_deform := COALESCE((p_evidence ->> 'deform_ratio')::numeric, 0);
        v_ear    := COALESCE((p_evidence ->> 'ear_range')::numeric, 0);
        v_descs  := p_evidence -> 'descriptors';

        IF v_total < c_pass_min_ms OR v_frames < c_pass_frames THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', 'La mesure a été trop courte pour conclure.');
        END IF;

        -- Le visage doit etre le bon d un bout a l autre de la fenetre : sans
        -- cela, on pourrait se montrer soi-meme puis substituer une photo.
        IF v_descs IS NULL OR jsonb_typeof(v_descs) <> 'array'
           OR jsonb_array_length(v_descs) < 2 THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', 'Le visage n''a pas pu être suivi pendant la mesure.');
        END IF;

        FOR v_i IN 0 .. jsonb_array_length(v_descs) - 1 LOOP
            v_desc := public.jsonb_to_descriptor(v_descs -> v_i);
            IF v_desc IS NULL OR array_length(v_desc, 1) <> 128 THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                    'detail', 'Le visage n''a pas pu être analysé pendant la mesure.');
            END IF;
            v_dist := public.face_distance(p_template, v_desc);
            IF v_dist IS NULL OR v_dist > p_max_distance THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_MISMATCH',
                    'detail', format('Le visage a changé pendant la mesure (écart %s).',
                        round(COALESCE(v_dist, 9)::numeric, 3)));
            END IF;
        END LOOP;

        -- Un seul des deux signaux suffit : un clignement est concluant a lui
        -- seul, une deformation nette aussi. Exiger les deux multiplierait les
        -- demandes de geste sans rien gagner contre une photographie, qui
        -- n en produit aucun.
        IF v_deform >= c_deform_min OR v_ear >= c_ear_min THEN
            RETURN jsonb_build_object('ok', TRUE, 'mode', 'PASSIVE',
                'deform_ratio', v_deform, 'ear_range', v_ear);
        END IF;

        RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
            'detail', format('Visage trop figé pour être distingué d''une photographie (%s).',
                round(v_deform, 2)));
    END IF;


    -- =====================================================================
    -- 4.b MODE GESTES
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
                'detail', format('Le visage a changé pendant le contrôle (écart %s).',
                    round(COALESCE(v_dist, 9)::numeric, 3)));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('ok', TRUE, 'mode', 'GESTURE',
        'actions', to_jsonb(v_ch.actions));
END;
$$;

REVOKE ALL ON FUNCTION public.validate_liveness(UUID, UUID, JSONB, DOUBLE PRECISION[], DOUBLE PRECISION) FROM PUBLIC;
