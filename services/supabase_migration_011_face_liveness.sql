-- =============================================================================
-- Winner Pointage — Migration 011 : test de vivacite par defi impose
--
-- Idempotente. A executer apres la migration 010.
--
-- LE PROBLEME QU ELLE RESOUT
-- --------------------------
-- La migration 010 compare un visage a une reference. Elle ne distingue pas un
-- visage VIVANT d une PHOTOGRAPHIE de ce visage brandie devant l objectif.
-- Un employe pouvait donc faire pointer un collegue avec une simple photo.
--
-- LE PRINCIPE
-- -----------
-- Le SERVEUR tire au sort une suite de gestes et l impose. Le navigateur guide
-- l employe, mesure ce qui se passe et renvoie ses mesures. Le SERVEUR verifie
-- que chaque geste a bien eu lieu, dans l ordre impose, dans le temps imparti.
--
-- Le defi est :
--   - imprevisible   : tire au sort a chaque pointage, cote serveur ;
--   - a usage unique : consomme des qu il sert, rejeu impossible ;
--   - perissable     : quelques dizaines de secondes de validite.
--
-- POURQUOI UNE PHOTO ECHOUE
-- -------------------------
-- Elle ne cligne pas des yeux. Et surtout : une photo inclinee ne produit PAS
-- la meme signature qu une vraie tete qui tourne. Incliner une image plate
-- comprime toute la surface du meme facteur, donc le rapport de distances
-- nez/machoire reste inchange. Sur une vraie tete, le nez est en relief : il se
-- deplace par rapport aux joues, et le rapport bascule franchement. C est ce
-- rapport que le serveur controle — un indice de relief, mesurable en 2D.
--
-- CE QUE CELA NE FAIT TOUJOURS PAS
-- --------------------------------
-- Les mesures sont calculees par le navigateur. Quelqu un qui modifie
-- l application peut fabriquer de fausses mesures. Ce dispositif arrete la
-- fraude ordinaire — la photo, le portable prete — pas un attaquant outille.
-- Fermer cela demanderait que le serveur voie les images lui-meme, donc un
-- service d inference (prevu : services/face).
-- =============================================================================


-- =============================================================================
-- 1. Reglage par entreprise
-- =============================================================================

ALTER TABLE public.companies
    -- Actif par defaut : desactiver rouvre le trou de la photo brandie.
    ADD COLUMN IF NOT EXISTS face_liveness_enabled BOOLEAN DEFAULT TRUE,
    -- Nombre de gestes imposes. 2 suffit : 12 combinaisons ordonnees, ce qui
    -- rend une video prete a l emploi impraticable.
    ADD COLUMN IF NOT EXISTS face_liveness_steps INT DEFAULT 2;

ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_liveness_steps_sane;
ALTER TABLE public.companies
    ADD CONSTRAINT companies_liveness_steps_sane
    CHECK (face_liveness_steps BETWEEN 1 AND 4);


-- =============================================================================
-- 2. Defis emis
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.face_challenges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,

    -- La suite de gestes imposee, dans l ordre.
    actions TEXT[] NOT NULL,

    issued_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Horodate des qu il sert. Un defi consomme ne resservira jamais.
    consumed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_face_challenges_user
    ON public.face_challenges (user_id, expires_at);

ALTER TABLE public.face_challenges ENABLE ROW LEVEL SECURITY;

-- Aucune politique : seules les fonctions SECURITY DEFINER y accedent. Un
-- client capable de lire ou d ecrire cette table pourrait se fabriquer un defi.
DROP POLICY IF EXISTS "Public & Anon access on face_challenges" ON public.face_challenges;


-- =============================================================================
-- 3. Emission d un defi
-- =============================================================================

CREATE OR REPLACE FUNCTION public.issue_face_challenge()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_user    public.users%ROWTYPE;
    v_company public.companies%ROWTYPE;
    -- Pas de gauche ni de droite dans les consignes.
    --
    -- La version precedente imposait TURN_LEFT / TURN_RIGHT. Determiner de quel
    -- cote tourne une tete depend de la convention des reperes du modele ET du
    -- fait que l apercu soit ou non en miroir — deux choses qui varient selon
    -- l appareil. Resultat sur le terrain : la consigne disait « gauche »
    -- pendant que la mesure attendait l autre sens, et personne ne pouvait
    -- pointer.
    --
    -- TURN_SIDE ne regarde que l AMPLITUDE de la rotation, quel qu en soit le
    -- sens. L indice de relief qui demasque une photographie est conserve
    -- intact : c est sa valeur absolue qui compte, pas son signe.
    v_pool    TEXT[] := ARRAY['BLINK', 'MOUTH_OPEN', 'TURN_SIDE'];
    v_actions TEXT[];
    v_n       INT;
    v_i       INT;
    v_j       INT;
    v_tmp     TEXT;
    v_id      UUID;
    v_ttl     INT := 90;   -- secondes
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

    v_n := LEAST(array_length(v_pool, 1), GREATEST(1, COALESCE(v_company.face_liveness_steps, 2)));

    -- Tirage sans remise, par melange de Fisher-Yates ECRIT A LA MAIN.
    --
    -- La version precedente utilisait « ORDER BY random() LIMIT n » dans un
    -- sous-select : le planificateur y voyait un sous-plan non correle, ne
    -- l evaluait qu UNE fois et reservait le meme resultat. Le defi sortait
    -- alors identique a chaque pointage — donc previsible, donc inutile.
    -- Une boucle explicite ne laisse aucune latitude au planificateur.
    v_actions := v_pool;
    FOR v_i IN REVERSE array_length(v_actions, 1) .. 2 LOOP
        v_j := 1 + floor(random() * v_i)::int;
        v_tmp           := v_actions[v_i];
        v_actions[v_i]  := v_actions[v_j];
        v_actions[v_j]  := v_tmp;
    END LOOP;
    v_actions := v_actions[1:v_n];

    -- Les defis en cours de cet employe tombent : un seul vivant a la fois,
    -- sinon on pourrait en collectionner et choisir le plus commode.
    UPDATE public.face_challenges
       SET consumed_at = NOW()
     WHERE user_id = v_uid AND consumed_at IS NULL;

    INSERT INTO public.face_challenges (user_id, company_id, actions, expires_at)
    VALUES (v_uid, v_user.company_id, v_actions, NOW() + make_interval(secs => v_ttl))
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'challenge_id', v_id,
        'actions', to_jsonb(v_actions),
        'expires_in', v_ttl);
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_face_challenge() TO authenticated;


-- =============================================================================
-- 4. Conversion d un tableau JSON en vecteur d empreinte
-- =============================================================================

CREATE OR REPLACE FUNCTION public.jsonb_to_descriptor(p JSONB)
RETURNS DOUBLE PRECISION[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v DOUBLE PRECISION[];
BEGIN
    IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN NULL; END IF;

    SELECT array_agg(x::text::double precision ORDER BY ord)
      INTO v
      FROM jsonb_array_elements(p) WITH ORDINALITY AS t(x, ord);

    RETURN v;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.jsonb_to_descriptor(JSONB) FROM PUBLIC;


-- =============================================================================
-- 5. Verification des preuves de vivacite
--
-- `p_evidence` a la forme :
--   { "steps": [ { "action": "BLINK",
--                  "t_start": 340, "t_end": 780,
--                  "ear_base": 0.30, "ear_min": 0.11,
--                  "yaw_peak": 1.2, "mar_peak": 0.06,
--                  "descriptor": [ ...128 nombres... ] },
--                ... ],
--     "total_ms": 2400, "frames": 38 }
--
-- Les seuils sont ecrits ici, cote serveur, et nulle part ailleurs : un seuil
-- lu depuis le client serait un seuil negociable par le client.
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

    -- Un oeil ouvert donne un rapport d aspect autour de 0,25-0,35 ; ferme,
    -- sous 0,15. On exige une CHUTE RELATIVE : ce rapport varie d une personne
    -- a l autre, un seuil absolu ferait echouer les yeux naturellement etroits.
    c_blink_ratio  CONSTANT NUMERIC := 0.62;   -- ear_min < 62 % de ear_base
    c_blink_base   CONSTANT NUMERIC := 0.16;   -- yeux vraiment ouverts au depart

    -- Rapport de distances nez/machoire, en VALEUR ABSOLUE. Une image plate
    -- inclinee reste sous 0,05 ; une vraie tete tournee d une vingtaine de
    -- degres depasse 0,15. Le seuil est pose entre les deux, assez bas pour
    -- qu une rotation modeste suffise : un seuil qu on n atteint pas empeche
    -- de travailler, ce qui est pire qu absent.
    c_yaw_min      CONSTANT NUMERIC := 0.11;

    -- Bouche ouverte : rapport d aspect des levres internes.
    c_mouth_min    CONSTANT NUMERIC := 0.30;

    -- Un geste demande du temps. Trois gestes en 100 ms trahissent un rejeu.
    c_step_min_ms  CONSTANT NUMERIC := 120;
    c_total_min_ms CONSTANT NUMERIC := 800;
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

    -- Consomme immediatement : meme si la suite echoue, ce defi ne resservira
    -- pas. Sans cela, on pourrait retenter en boucle sur le meme defi.
    UPDATE public.face_challenges SET consumed_at = NOW() WHERE id = p_challenge_id;

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

        -- 5.1 Le bon geste, a la bonne place
        IF (v_step ->> 'action') IS DISTINCT FROM v_attendu THEN
            RETURN jsonb_build_object('ok', FALSE, 'code', 'LIVENESS_FAILED',
                'detail', 'Les gestes n''ont pas été effectués dans l''ordre demandé.');
        END IF;

        -- 5.2 Chronologie strictement croissante et non instantanee
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

        -- 5.3 La mesure propre au geste
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

        -- TURN_LEFT et TURN_RIGHT ne sont plus jamais tires, mais restent
        -- acceptes : un defi emis juste avant la mise a jour doit pouvoir
        -- aboutir plutot que de refuser un employe de bonne foi.
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

        -- 5.4 LE CONTROLE DECISIF : c est bien la MEME personne a chaque geste.
        --
        -- Sans lui, il suffirait de cligner des yeux avec son propre visage,
        -- puis de brandir la photo du collegue pour la capture finale.
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

    RETURN jsonb_build_object('ok', TRUE, 'actions', to_jsonb(v_ch.actions));
END;
$$;

REVOKE ALL ON FUNCTION public.validate_liveness(UUID, UUID, JSONB, DOUBLE PRECISION[], DOUBLE PRECISION) FROM PUBLIC;


-- =============================================================================
-- 6. Purge
-- =============================================================================

CREATE OR REPLACE FUNCTION public.purge_face_challenges()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INT;
BEGIN
    DELETE FROM public.face_challenges WHERE issued_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;
