-- =============================================================================
-- Winner Pointage — Migration 016 : le pointage passe toujours, le doute part
--                                    en verification RH
--
-- Idempotente. A executer apres la migration 015.
--
-- CE QUI NE MARCHAIT PAS, ET POURQUOI
-- -----------------------------------
-- Le controle anti-photo passif compare la dispersion des points DEFORMABLES
-- (paupieres, levres) a celle des points RIGIDES (arete du nez). J'ai pose le
-- seuil en supposant qu'une photographie donnerait un rapport voisin de 1.
--
-- C'est FAUX. Les paupieres et les levres sont intrinsequement plus difficiles
-- a localiser que l'arete du nez : le detecteur y est plus bruite. Meme sur une
-- image parfaitement figee, le rapport depasse 1. La vraie ligne de partage
-- entre un visage vivant et une photographie n'est pas connue, et aucun seuil
-- pose sans mesure de terrain ne peut etre juste.
--
-- Consequence observee : des employes deja enroles etaient renvoyes vers un
-- geste a presque chaque pointage.
--
-- CE QUE CETTE MIGRATION CHANGE
-- -----------------------------
-- On cesse de faire BLOQUER un indicateur dont on ignore le point de bascule.
--
-- Quand la mesure passive ne conclut pas, le pointage est ACCEPTE mais marque
-- PENDING_REVIEW : il apparait dans le cockpit RH en attente de verification,
-- avec le selfie horodate. L'employe pointe en deux ou trois secondes ; le
-- service RH voit exactement ce qui n'a pas pu etre confirme.
--
-- C'est plus honnete que les deux alternatives :
--   - baisser le seuil jusqu'a ce que tout passe reviendrait a afficher
--     « identite verifiee » sans rien verifier ;
--   - imposer un geste a chaque fois rend l'outil inutilisable.
--
-- CE QUI NE CHANGE PAS
-- --------------------
-- La comparaison des visages reste BLOQUANTE : un visage qui ne correspond pas
-- a la reference est refuse, sans appel. C'est le controle qui repose sur une
-- frontiere connue (0,600, celle du modele), et lui seul.
--
-- Les entreprises qui veulent un blocage dur disposent du mode GESTURE.
-- =============================================================================


-- =============================================================================
-- 1. Que faire quand la mesure passive ne conclut pas
-- =============================================================================

ALTER TABLE public.companies
    -- REVIEW  : accepter et marquer pour verification RH (par defaut).
    -- GESTURE : demander un geste, comme avant.
    ADD COLUMN IF NOT EXISTS face_liveness_fallback TEXT DEFAULT 'REVIEW';

ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_liveness_fallback_sane;
ALTER TABLE public.companies
    ADD CONSTRAINT companies_liveness_fallback_sane
    CHECK (face_liveness_fallback IN ('REVIEW', 'GESTURE'));

UPDATE public.companies
   SET face_liveness_fallback = 'REVIEW'
 WHERE face_liveness_fallback IS NULL;


-- =============================================================================
-- 2. Le clignement des yeux disparait des gestes tires au sort
--
-- C'est le geste le moins fiable a detecter : un clignement dure une centaine
-- de millisecondes, et il faut tomber dessus. Restent la bouche et la rotation
-- de la tete, tous deux tenus assez longtemps pour etre captes a coup sur.
-- =============================================================================

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
    -- Plus de BLINK : trop bref pour etre capte de facon fiable.
    v_pool    TEXT[] := ARRAY['MOUTH_OPEN', 'TURN_SIDE'];
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

    IF COALESCE(v_company.face_liveness_mode, 'PASSIVE') = 'GESTURE' THEN
        v_mode := 'GESTURE';
    ELSE
        v_mode := CASE WHEN upper(COALESCE(p_mode, 'PASSIVE')) = 'GESTURE'
                       THEN 'GESTURE' ELSE 'PASSIVE' END;
    END IF;

    IF v_mode = 'GESTURE' THEN
        -- Un seul geste suffit desormais : deux geste a chaque pointage, matin
        -- et soir, tous les jours, personne ne le supporte.
        v_n := LEAST(array_length(v_pool, 1),
                     GREATEST(1, COALESCE(v_company.face_liveness_steps, 1)));

        v_actions := v_pool;
        FOR v_i IN REVERSE array_length(v_actions, 1) .. 2 LOOP
            v_j := 1 + floor(random() * v_i)::int;
            v_tmp          := v_actions[v_i];
            v_actions[v_i] := v_actions[v_j];
            v_actions[v_j] := v_tmp;
        END LOOP;
        v_actions := v_actions[1:v_n];
    END IF;

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

-- Deux gestes par pointage n'ont plus lieu d'etre : on retombe a un.
UPDATE public.companies SET face_liveness_steps = 1 WHERE COALESCE(face_liveness_steps, 2) > 1;
ALTER TABLE public.companies ALTER COLUMN face_liveness_steps SET DEFAULT 1;


-- =============================================================================
-- 3. Une mesure passive qui ne conclut pas ne bloque plus
--
-- `validate_liveness` renvoie desormais un troisieme etat : « accepte, mais a
-- verifier ». record_attendance le traduit en PENDING_REVIEW.
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
    v_ch       public.face_challenges%ROWTYPE;
    v_company  public.companies%ROWTYPE;
    v_steps    JSONB;
    v_step     JSONB;
    v_attendu  TEXT;
    v_i        INT;
    v_prev_t   NUMERIC := -1;
    v_desc     DOUBLE PRECISION[];
    v_dist     DOUBLE PRECISION;
    v_total    NUMERIC;
    v_frames   INT;
    v_deform   NUMERIC;
    v_ear      NUMERIC;
    v_yaw      NUMERIC;
    v_descs    JSONB;
    v_repli    TEXT;

    c_yaw_min      CONSTANT NUMERIC := 0.11;
    c_mouth_min    CONSTANT NUMERIC := 0.30;
    c_step_min_ms  CONSTANT NUMERIC := 120;
    c_total_min_ms CONSTANT NUMERIC := 800;

    -- Ces seuils NE BLOQUENT PLUS : ils decident seulement si le pointage part
    -- en verification humaine. Leur point de bascule exact est inconnu, ce qui
    -- interdit de leur confier un refus.
    c_deform_min   CONSTANT NUMERIC := 1.35;
    c_ear_min      CONSTANT NUMERIC := 0.055;
    -- PAS de seuil sur l amplitude de rotation : agiter une PHOTOGRAPHIE la
    -- fait grimper autant qu un vrai mouvement de tete. S en servir comme
    -- signe de vie reviendrait a valider precisement l attaque a bloquer.

    c_pass_min_ms  CONSTANT NUMERIC := 600;
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

    SELECT * INTO v_company FROM public.companies WHERE id = v_ch.company_id;
    v_repli := COALESCE(v_company.face_liveness_fallback, 'REVIEW');


    -- =====================================================================
    -- MODE PASSIF
    -- =====================================================================
    IF COALESCE(v_ch.mode, 'GESTURE') = 'PASSIVE' THEN
        v_total  := COALESCE((p_evidence ->> 'duration_ms')::numeric, 0);
        v_frames := COALESCE((p_evidence ->> 'frames')::int, 0);
        v_deform := COALESCE((p_evidence ->> 'deform_ratio')::numeric, 0);
        v_ear    := COALESCE((p_evidence ->> 'ear_range')::numeric, 0);
        v_yaw    := COALESCE((p_evidence ->> 'yaw_range')::numeric, 0);
        v_descs  := p_evidence -> 'descriptors';

        -- LE CONTROLE QUI BLOQUE : est-ce bien la bonne personne ?
        --
        -- Celui-ci s'appuie sur une frontiere connue — celle du modele — et
        -- reste sans appel. C'est le seul du mode passif.
        IF v_descs IS NULL OR jsonb_typeof(v_descs) <> 'array'
           OR jsonb_array_length(v_descs) < 1 THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_NOT_CAPTURED',
                'detail', 'Aucun visage exploitable sur les clichés.');
        END IF;

        FOR v_i IN 0 .. jsonb_array_length(v_descs) - 1 LOOP
            v_desc := public.jsonb_to_descriptor(v_descs -> v_i);
            IF v_desc IS NULL OR array_length(v_desc, 1) <> 128 THEN
                CONTINUE;
            END IF;
            v_dist := public.face_distance(p_template, v_desc);
            IF v_dist IS NULL OR v_dist > p_max_distance THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'FACE_MISMATCH',
                    'detail', format('Le visage ne correspond pas (écart %s, maximum %s).',
                        round(COALESCE(v_dist, 9)::numeric, 3), p_max_distance));
            END IF;
        END LOOP;

        -- LE CONTROLE QUI NE BLOQUE PAS : le visage semble-t-il vivant ?
        -- Deux empreintes au moins sont exigees pour une acceptation nette :
        -- c est ce qui prouve que le visage n a pas ete substitue entre le
        -- premier et le dernier cliche. Avec une seule, on accepte quand meme,
        -- mais en verification RH.
        IF v_total >= c_pass_min_ms AND v_frames >= c_pass_frames
           AND jsonb_array_length(v_descs) >= 2
           AND (v_deform >= c_deform_min OR v_ear >= c_ear_min) THEN
            RETURN jsonb_build_object('ok', TRUE, 'mode', 'PASSIVE',
                'deform_ratio', v_deform, 'ear_range', v_ear, 'yaw_range', v_yaw);
        END IF;

        -- Indecis. Selon le reglage de l'entreprise : geste, ou verification RH.
        IF v_repli = 'GESTURE' THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_TOO_STATIC',
                'detail', format('Visage trop figé entre les clichés (déformation %s, mouvement %s).',
                    round(v_deform, 2), round(v_yaw, 3)));
        END IF;

        RETURN jsonb_build_object('ok', TRUE, 'mode', 'PASSIVE', 'soft', TRUE,
            'deform_ratio', v_deform, 'yaw_range', v_yaw,
            'detail', format('Vivacité non confirmée (déformation %s, mouvement %s) : à vérifier.',
                round(v_deform, 2), round(v_yaw, 3)));
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

        IF v_attendu IN ('TURN_SIDE', 'TURN_LEFT', 'TURN_RIGHT') THEN
            IF abs(COALESCE((v_step ->> 'yaw_peak')::numeric, 0)) < c_yaw_min THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'La tête n''a pas assez tourné sur le côté.');
            END IF;

        ELSIF v_attendu = 'MOUTH_OPEN' THEN
            IF COALESCE((v_step ->> 'mar_peak')::numeric, 0) < c_mouth_min THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'La bouche ne s''est pas ouverte.');
            END IF;

        -- BLINK n'est plus tire au sort, mais un defi emis juste avant la mise
        -- a jour doit pouvoir aboutir plutot que de refuser un employe.
        ELSIF v_attendu = 'BLINK' THEN
            IF COALESCE((v_step ->> 'ear_min')::numeric, 1)
               > COALESCE((v_step ->> 'ear_base')::numeric, 0) * 0.62 THEN
                RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                    'detail', 'Aucun clignement d''yeux n''a été détecté.');
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
