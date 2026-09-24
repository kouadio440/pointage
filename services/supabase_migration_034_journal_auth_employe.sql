-- =============================================================================
--  MIGRATION 034 — JOURNAL D'AUTHENTIFICATION : PARCOURS EMPLOYE
-- =============================================================================
--
--  POURQUOI
--  --------
--  `public.log_auth_event` ecarte en silence tout evenement absent de la liste
--  autorisee : les noms propres au parcours employe n'etaient donc jamais
--  enregistres, et le front croyait journaliser alors que rien n'arrivait.
--  Sans ces traces, impossible de savoir OU un employe decroche entre le code
--  entreprise et son espace.
--
--  CE QUE FAIT CETTE MIGRATION
--  ---------------------------
--    - etend la liste des evenements acceptes aux etapes du parcours employe,
--      DANS LA CONTRAINTE **ET** DANS LE CORPS DE LA FONCTION : c'est ce
--      dernier qui filtre reellement. La contrainte autorisait deja
--      'COMPANY_CREATED' et 'JOIN_REQUESTED' que la fonction rejetait —
--      ces deux-la sont donc egalement debloques ;
--    - ajoute le flux 'employee_login' (une connexion d'employe n'etait
--      representable par aucune des trois valeurs existantes).
--
--  Strictement ADDITIF : aucune donnee n'est modifiee ni supprimee, aucun
--  evenement existant ne cesse d'etre accepte. Retour arriere fourni dans
--  supabase_migration_034_journal_auth_employe_retour.sql
-- =============================================================================

BEGIN;

ALTER TABLE public.auth_events DROP CONSTRAINT IF EXISTS auth_events_event_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_event_check
    CHECK (event = ANY (ARRAY[
        -- Existants, inchanges.
        'OTP_REQUESTED', 'OTP_SENT', 'OTP_SEND_FAILED', 'OTP_RATE_LIMITED',
        'OTP_VERIFIED', 'OTP_INVALID', 'OTP_EXPIRED',
        'GOOGLE_STARTED', 'GOOGLE_FAILED',
        'COMPANY_CREATED', 'JOIN_REQUESTED',
        -- Parcours employe : du code entreprise jusqu'a son espace.
        'EMPLOYEE_COMPANY_CODE_VALIDATED',
        'EMPLOYEE_OTP_REQUEST_STARTED',
        'EMPLOYEE_OTP_REQUEST_SUCCESS',
        'EMPLOYEE_OTP_REQUEST_FAILED',
        'EMPLOYEE_OTP_VERIFIED',
        'EMPLOYEE_OTP_INVALID',
        'EMPLOYEE_JOIN_REQUEST_CREATED',
        'EMPLOYEE_JOIN_REQUEST_ALREADY_EXISTS',
        'EMPLOYEE_JOIN_REQUEST_APPROVED',
        'EMPLOYEE_MEMBERSHIP_CREATED'
    ]));

ALTER TABLE public.auth_events DROP CONSTRAINT IF EXISTS auth_events_flow_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_flow_check
    CHECK (flow IS NULL OR flow = ANY (ARRAY[
        'company_login', 'company_signup', 'employee_join', 'employee_login'
    ]));

-- -----------------------------------------------------------------------------
--  La fonction porte sa PROPRE liste : sans cette redefinition, elle continue
--  d'ecarter en silence les evenements du parcours employe.
--  Seule la liste change ; empreinte d'adresse, plafonds et purge sont repris
--  a l'identique de la migration 026.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_auth_event(
    p_event      TEXT,
    p_email      TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_flow       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash    TEXT := public.empreinte_email(p_email);
    v_domaine TEXT := NULLIF(lower(split_part(btrim(COALESCE(p_email, '')), '@', 2)), '');
    v_erreur  TEXT := NULLIF(left(regexp_replace(COALESCE(p_error_code, ''), '[^a-zA-Z0-9_]', '', 'g'), 64), '');
    v_flux    TEXT := p_flow;
BEGIN
    IF p_event IS NULL OR p_event NOT IN (
            'OTP_REQUESTED', 'OTP_SENT', 'OTP_SEND_FAILED', 'OTP_RATE_LIMITED',
            'OTP_VERIFIED', 'OTP_INVALID', 'OTP_EXPIRED',
            'GOOGLE_STARTED', 'GOOGLE_FAILED',
            'COMPANY_CREATED', 'JOIN_REQUESTED',
            'EMPLOYEE_COMPANY_CODE_VALIDATED',
            'EMPLOYEE_OTP_REQUEST_STARTED', 'EMPLOYEE_OTP_REQUEST_SUCCESS',
            'EMPLOYEE_OTP_REQUEST_FAILED',
            'EMPLOYEE_OTP_VERIFIED', 'EMPLOYEE_OTP_INVALID',
            'EMPLOYEE_JOIN_REQUEST_CREATED', 'EMPLOYEE_JOIN_REQUEST_ALREADY_EXISTS',
            'EMPLOYEE_JOIN_REQUEST_APPROVED', 'EMPLOYEE_MEMBERSHIP_CREATED') THEN
        RETURN;
    END IF;

    IF v_flux IS NOT NULL AND v_flux NOT IN ('company_login', 'company_signup',
                                             'employee_join', 'employee_login') THEN
        v_flux := NULL;
    END IF;

    IF v_domaine IS NOT NULL AND v_domaine !~ '^[a-z0-9.-]{1,253}$' THEN
        v_domaine := NULL;
    END IF;

    -- Plafonds : 30 evenements par adresse sur 10 minutes, 600 par minute au total.
    IF v_hash IS NOT NULL AND (SELECT count(*) FROM public.auth_events
                                WHERE email_hash = v_hash AND created_at > NOW() - INTERVAL '10 minutes') >= 30 THEN
        RETURN;
    END IF;
    IF (SELECT count(*) FROM public.auth_events WHERE created_at > NOW() - INTERVAL '1 minute') >= 600 THEN
        RETURN;
    END IF;

    INSERT INTO public.auth_events (event, flow, email_hash, email_domain, error_code, user_id)
    VALUES (p_event, v_flux, v_hash, v_domaine, v_erreur, auth.uid());

    -- Conservation limitee a 30 jours, purgee au fil de l'eau.
    IF random() < 0.02 THEN
        DELETE FROM public.auth_events WHERE created_at < NOW() - INTERVAL '30 days';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.log_auth_event(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_auth_event(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

COMMIT;
