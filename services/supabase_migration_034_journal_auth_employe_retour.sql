-- =============================================================================
--  RETOUR ARRIERE DE LA MIGRATION 034
-- =============================================================================
--  Restaure les deux contraintes dans leur forme d'origine.
--
--  ATTENTION : si des evenements du parcours employe ont deja ete enregistres,
--  la contrainte d'origine les refuserait. Ils sont donc supprimes d'abord —
--  ce sont des traces de diagnostic, aucune donnee metier.
-- =============================================================================

BEGIN;

DELETE FROM public.auth_events WHERE event LIKE 'EMPLOYEE\_%';
UPDATE public.auth_events SET flow = NULL WHERE flow = 'employee_login';

ALTER TABLE public.auth_events DROP CONSTRAINT IF EXISTS auth_events_event_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_event_check
    CHECK (event = ANY (ARRAY[
        'OTP_REQUESTED', 'OTP_SENT', 'OTP_SEND_FAILED', 'OTP_RATE_LIMITED',
        'OTP_VERIFIED', 'OTP_INVALID', 'OTP_EXPIRED',
        'GOOGLE_STARTED', 'GOOGLE_FAILED',
        'COMPANY_CREATED', 'JOIN_REQUESTED'
    ]));

ALTER TABLE public.auth_events DROP CONSTRAINT IF EXISTS auth_events_flow_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_flow_check
    CHECK (flow IS NULL OR flow = ANY (ARRAY[
        'company_login', 'company_signup', 'employee_join'
    ]));

COMMIT;
