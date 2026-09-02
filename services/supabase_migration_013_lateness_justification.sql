-- =============================================================================
-- Winner Pointage — Migration 013 : justification des retards
--
-- Idempotente. A executer apres la migration 012.
--
-- CE QU ELLE APPORTE
-- ------------------
-- Le retard etait constate mais jamais explique. L employe n avait aucun moyen
-- de dire « panne de taxi », et le service RH aucun moyen de trancher. La
-- colonne « Motif / Justification » des deux tableaux restait vide des deux
-- cotes.
--
-- POURQUOI DES FONCTIONS ET PAS UN SIMPLE UPDATE
-- ----------------------------------------------
-- `attendances` ne porte QU UNE politique RLS, en lecture. Aucun role
-- applicatif ne peut y ecrire, et c est voulu : un pointage ne se modifie pas.
-- Une justification est une annotation, pas une correction du pointage — elle
-- passe donc par deux fonctions SECURITY DEFINER, qui verifient chacune ce
-- qu elles ont le droit de toucher.
--
-- QUI PEUT QUOI
-- -------------
--   - l employe justifie SON retard, et seulement un retard reel ;
--   - le service RH tranche, et ne peut PAS trancher son propre retard.
-- =============================================================================


-- =============================================================================
-- 1. Colonnes
-- =============================================================================

ALTER TABLE public.attendances
    -- Ce que l employe ecrit.
    ADD COLUMN IF NOT EXISTS late_justification   TEXT,
    ADD COLUMN IF NOT EXISTS late_justified_at    TIMESTAMP WITH TIME ZONE,

    -- NULL = aucune justification deposee.
    ADD COLUMN IF NOT EXISTS late_status          VARCHAR(20),

    -- Ce que le service RH decide.
    ADD COLUMN IF NOT EXISTS late_reviewed_by_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS late_reviewed_at     TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS late_review_comment  TEXT;

ALTER TABLE public.attendances
    DROP CONSTRAINT IF EXISTS attendances_late_status_sane;
ALTER TABLE public.attendances
    ADD CONSTRAINT attendances_late_status_sane
    CHECK (late_status IS NULL OR late_status IN ('PENDING', 'ACCEPTED', 'REJECTED'));

-- Le cockpit RH liste les justifications en attente : c est la seule requete
-- frequente sur ces colonnes.
CREATE INDEX IF NOT EXISTS idx_attendances_late_status
    ON public.attendances (company_id, late_status)
    WHERE late_status IS NOT NULL;


-- =============================================================================
-- 2. L employe justifie son retard
-- =============================================================================

CREATE OR REPLACE FUNCTION public.justify_lateness(
    p_attendance_id UUID,
    p_reason        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_att  public.attendances%ROWTYPE;
    v_txt  TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_att FROM public.attendances WHERE id = p_attendance_id;

    -- Un pointage qui ne vous appartient pas doit rester INTROUVABLE, et non
    -- « interdit » : un refus explicite confirmerait qu il existe.
    IF NOT FOUND OR v_att.user_id <> v_uid THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_FOUND',
            'message', 'Ce pointage est introuvable.');
    END IF;

    IF COALESCE(v_att.late_minutes, 0) <= 0 AND v_att.status <> 'late' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_LATE',
            'message', 'Ce pointage n''est pas en retard : il n''y a rien à justifier.');
    END IF;

    -- Une justification deja acceptee est close. La rouvrir permettrait de
    -- remplacer, apres coup, le texte sur lequel le RH s est prononce.
    IF v_att.late_status = 'ACCEPTED' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'ALREADY_ACCEPTED',
            'message', 'Cette justification a déjà été acceptée par le service RH.');
    END IF;

    IF length(v_txt) < 10 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'TOO_SHORT',
            'message', 'Expliquez votre retard en quelques mots (10 caractères minimum).');
    END IF;

    IF length(v_txt) > 1000 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'TOO_LONG',
            'message', 'Votre explication dépasse 1000 caractères.');
    END IF;

    UPDATE public.attendances
       SET late_justification  = v_txt,
           late_justified_at   = NOW(),
           late_status         = 'PENDING',
           -- Une nouvelle justification remet la decision a zero : le RH doit
           -- se prononcer sur le texte qu il a reellement sous les yeux.
           late_reviewed_by_id = NULL,
           late_reviewed_at    = NULL,
           late_review_comment = NULL,
           updated_at          = NOW()
     WHERE id = p_attendance_id;

    RETURN jsonb_build_object('ok', TRUE, 'status', 'PENDING',
        'message', 'Votre justification a été transmise au service RH.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.justify_lateness(UUID, TEXT) TO authenticated;


-- =============================================================================
-- 3. Le service RH tranche
-- =============================================================================

CREATE OR REPLACE FUNCTION public.decide_lateness(
    p_attendance_id UUID,
    p_accept        BOOLEAN,
    p_comment       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_att public.attendances%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_att FROM public.attendances WHERE id = p_attendance_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_FOUND',
            'message', 'Ce pointage est introuvable.');
    END IF;

    IF NOT public.can_configure_company(v_att.company_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'FORBIDDEN',
            'message', 'Seuls le CEO et le service RH peuvent valider un retard.');
    END IF;

    -- Personne ne valide son propre retard. Un responsable qui le pourrait
    -- viderait le controle de son sens, et la trace laissee en base ne
    -- vaudrait plus rien devant un litige.
    IF v_att.user_id = v_uid THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SELF_REVIEW',
            'message', 'Vous ne pouvez pas valider votre propre retard. Un autre responsable doit s''en charger.');
    END IF;

    IF v_att.late_status IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_JUSTIFIED',
            'message', 'Cet employé n''a pas encore déposé de justification.');
    END IF;

    UPDATE public.attendances
       SET late_status         = CASE WHEN p_accept THEN 'ACCEPTED' ELSE 'REJECTED' END,
           late_reviewed_by_id = v_uid,
           late_reviewed_at    = NOW(),
           late_review_comment = NULLIF(btrim(COALESCE(p_comment, '')), ''),
           updated_at          = NOW()
     WHERE id = p_attendance_id;

    RETURN jsonb_build_object('ok', TRUE,
        'status', CASE WHEN p_accept THEN 'ACCEPTED' ELSE 'REJECTED' END,
        'message', CASE WHEN p_accept
                        THEN 'Retard justifié : la décision est enregistrée.'
                        ELSE 'Justification refusée : la décision est enregistrée.' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_lateness(UUID, BOOLEAN, TEXT) TO authenticated;
