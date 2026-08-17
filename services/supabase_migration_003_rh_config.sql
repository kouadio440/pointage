-- =============================================================================
-- Winner Pointage — Migration 003 : Configuration RH du pointage
--
-- À exécuter APRÈS supabase_migration_002_attendance.sql. Idempotente.
--
-- OBJET
-- -----
-- Faire du Cockpit Client RH la SOURCE DE VÉRITÉ du pointage. Le Dashboard
-- Employé ne décide plus rien : il lit la configuration de son entreprise et
-- se contente d'exécuter. Tant que la configuration est incomplète, le
-- pointage est bloqué proprement plutôt que d'échouer sans explication.
--
-- Ce fichier apporte :
--   1. Les horaires de travail (absents jusqu'ici)
--   2. Les sites additionnels autorisés par employé (multi-sites)
--   3. get_employee_punch_config()  — ce que le Dashboard Employé doit savoir
--   4. get_company_punch_readiness() — l'état de préparation, pour le RH
--   5. record_attendance v2 — site le plus proche + calcul du retard
--   6. Des politiques d'écriture : un EMPLOYEE ne peut pas modifier un rayon
-- =============================================================================


-- =============================================================================
-- 1. HORAIRES DE TRAVAIL
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.work_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,

    name VARCHAR(120) NOT NULL,
    -- Jours travaillés, 1 = lundi … 7 = dimanche (norme ISO).
    work_days INT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
    start_minute INT NOT NULL DEFAULT 480,   -- 08:00
    end_minute   INT NOT NULL DEFAULT 1020,  -- 17:00
    break_minutes INT DEFAULT 60,
    -- Marge avant qu'une arrivée soit comptée comme un retard.
    tolerance_minutes INT DEFAULT 10,

    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT work_schedules_unique_name UNIQUE (company_id, name),
    CONSTRAINT work_schedules_minutes_valid CHECK (
        start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439
    )
);

CREATE INDEX IF NOT EXISTS idx_schedules_company ON public.work_schedules(company_id, is_active);
ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.work_schedules(id) ON DELETE SET NULL,
    -- Distinct du rôle : un RH peut piloter le Cockpit ET être soumis au pointage.
    ADD COLUMN IF NOT EXISTS attendance_required BOOLEAN DEFAULT TRUE;


-- =============================================================================
-- 2. SITES ADDITIONNELS AUTORISÉS (multi-sites)
--
-- users.site_id reste le site PRINCIPAL. Cette table ajoute les sites
-- supplémentaires où l'employé a le droit de pointer (chantiers, agences).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.employee_sites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    site_id UUID REFERENCES public.geofences(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_sites_company ON public.employee_sites(company_id, user_id);
ALTER TABLE public.employee_sites ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 3. PARAMÈTRES DE SÉCURITÉ COMPLÉMENTAIRES
-- =============================================================================

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS require_check_in BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS require_check_out BOOLEAN DEFAULT TRUE,
    -- Par défaut FALSE : un pointage hors zone est REFUSÉ, pas seulement signalé.
    ADD COLUMN IF NOT EXISTS allow_out_of_zone BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS require_schedule BOOLEAN DEFAULT FALSE;


-- =============================================================================
-- 4. CE QUE LE DASHBOARD EMPLOYÉ DOIT SAVOIR
--
-- Une seule requête renvoie toute la configuration applicable ET l'état de
-- préparation. Le frontend n'a ainsi aucune règle à deviner ni à coder en dur.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_employee_punch_config()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid      UUID := auth.uid();
    v_user     public.users%ROWTYPE;
    v_company  public.companies%ROWTYPE;
    v_site     public.geofences%ROWTYPE;
    v_sched    public.work_schedules%ROWTYPE;
    v_sites    JSONB := '[]'::jsonb;
    v_missing  TEXT[] := ARRAY[]::TEXT[];
    v_required BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ready', FALSE, 'reason', 'NOT_AUTHENTICATED');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ready', FALSE, 'reason', 'EMPLOYEE_NOT_FOUND',
            'missing', to_jsonb(ARRAY['Votre fiche employé n''existe pas encore']));
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;

    -- Obligation de pointer : la fiche employé prime, le rattachement complète.
    v_required := COALESCE(
        v_user.attendance_required,
        (SELECT m.attendance_required FROM public.company_memberships m
          WHERE m.user_id = v_user.id AND m.company_id = v_user.company_id),
        TRUE
    );

    IF NOT COALESCE(v_user.is_active, TRUE) THEN
        v_missing := v_missing || 'Votre compte est désactivé';
    END IF;

    IF v_company.id IS NULL THEN
        v_missing := v_missing || 'Aucune entreprise rattachée';
    ELSIF v_company.status IN ('suspended', 'expired') THEN
        v_missing := v_missing || 'Abonnement de l''entreprise inactif';
    END IF;

    -- Site principal, puis sites additionnels autorisés.
    IF v_user.site_id IS NOT NULL THEN
        SELECT * INTO v_site FROM public.geofences
        WHERE id = v_user.site_id AND company_id = v_user.company_id;
    END IF;

    IF v_site.id IS NULL THEN
        v_missing := v_missing || 'Aucun site de travail ne vous est affecté';
    ELSIF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN
        v_missing := v_missing || 'Votre site n''a pas de coordonnées GPS';
    ELSIF NOT COALESCE(v_site.is_active, TRUE) THEN
        v_missing := v_missing || 'Votre site de travail est désactivé';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name,
               'latitude', g.latitude, 'longitude', g.longitude,
               'radius_m', g.radius_meters)), '[]'::jsonb)
      INTO v_sites
      FROM public.geofences g
     WHERE g.company_id = v_user.company_id
       AND COALESCE(g.is_active, TRUE)
       AND g.latitude IS NOT NULL
       AND (g.id = v_user.site_id
            OR g.id IN (SELECT es.site_id FROM public.employee_sites es WHERE es.user_id = v_user.id));

    -- Horaire : bloquant uniquement si l'entreprise l'exige.
    IF v_user.schedule_id IS NOT NULL THEN
        SELECT * INTO v_sched FROM public.work_schedules
        WHERE id = v_user.schedule_id AND company_id = v_user.company_id;
    END IF;

    IF v_sched.id IS NULL AND COALESCE(v_company.require_schedule, FALSE) THEN
        v_missing := v_missing || 'Aucun horaire de travail ne vous est attribué';
    END IF;

    RETURN jsonb_build_object(
        'ready',              (array_length(v_missing, 1) IS NULL) AND v_required,
        'attendance_required', v_required,
        'missing',            to_jsonb(v_missing),
        'employee', jsonb_build_object(
            'id', v_user.id, 'full_name', v_user.full_name,
            'matricule', v_user.registration_number, 'is_active', v_user.is_active),
        'company', jsonb_build_object(
            'id', v_company.id, 'name', v_company.name,
            'attendance_method', COALESCE(v_company.attendance_method, 'GPS_SELFIE'),
            'max_gps_accuracy_m', COALESCE(v_company.max_gps_accuracy_m, 100),
            'require_check_in', COALESCE(v_company.require_check_in, TRUE),
            'require_check_out', COALESCE(v_company.require_check_out, TRUE),
            'face_verification_enabled', COALESCE(v_company.face_verification_enabled, FALSE)),
        'primary_site', CASE WHEN v_site.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_site.id, 'name', v_site.name,
            'latitude', v_site.latitude, 'longitude', v_site.longitude,
            'radius_m', v_site.radius_meters) END,
        'allowed_sites', v_sites,
        'schedule', CASE WHEN v_sched.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_sched.id, 'name', v_sched.name,
            'start_minute', v_sched.start_minute, 'end_minute', v_sched.end_minute,
            'tolerance_minutes', v_sched.tolerance_minutes,
            'work_days', to_jsonb(v_sched.work_days)) END
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_employee_punch_config() TO authenticated;


-- =============================================================================
-- 5. ÉTAT DE PRÉPARATION — vue RH
--
-- Permet au RH de voir, AVANT le matin du pointage, quels employés ne pourront
-- pas pointer et pourquoi.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_company_punch_readiness()
RETURNS TABLE (
    user_id UUID,
    full_name TEXT,
    matricule TEXT,
    is_active BOOLEAN,
    attendance_required BOOLEAN,
    site_name TEXT,
    site_ok BOOLEAN,
    schedule_name TEXT,
    schedule_ok BOOLEAN,
    ready BOOLEAN,
    missing TEXT[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company_id UUID;
BEGIN
    SELECT u.company_id INTO v_company_id FROM public.users u WHERE u.id = auth.uid();

    -- Réservé aux rôles habilités : un employé n'a pas à connaître l'état de
    -- configuration de ses collègues.
    IF v_company_id IS NULL OR NOT public.can_view_company_attendance(v_company_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.full_name::TEXT,
        u.registration_number::TEXT,
        COALESCE(u.is_active, TRUE),
        COALESCE(u.attendance_required, TRUE),
        g.name::TEXT,
        (g.id IS NOT NULL AND g.latitude IS NOT NULL AND COALESCE(g.is_active, TRUE)),
        s.name::TEXT,
        (s.id IS NOT NULL),
        (
            COALESCE(u.is_active, TRUE)
            AND COALESCE(u.attendance_required, TRUE)
            AND g.id IS NOT NULL AND g.latitude IS NOT NULL AND COALESCE(g.is_active, TRUE)
            AND (s.id IS NOT NULL OR NOT COALESCE(c.require_schedule, FALSE))
        ),
        ARRAY_REMOVE(ARRAY[
            CASE WHEN NOT COALESCE(u.is_active, TRUE) THEN 'Compte désactivé' END,
            CASE WHEN g.id IS NULL THEN 'Aucun site affecté' END,
            CASE WHEN g.id IS NOT NULL AND g.latitude IS NULL THEN 'Site sans coordonnées GPS' END,
            CASE WHEN g.id IS NOT NULL AND NOT COALESCE(g.is_active, TRUE) THEN 'Site désactivé' END,
            CASE WHEN s.id IS NULL AND COALESCE(c.require_schedule, FALSE) THEN 'Aucun horaire affecté' END
        ], NULL)
    FROM public.users u
    JOIN public.companies c ON c.id = u.company_id
    LEFT JOIN public.geofences g ON g.id = u.site_id
    LEFT JOIN public.work_schedules s ON s.id = u.schedule_id
    WHERE u.company_id = v_company_id
    ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_company_punch_readiness() TO authenticated;


-- =============================================================================
-- 6. record_attendance v2 — site le plus proche + calcul du retard
--
-- Remplace la version 002. Deux ajouts :
--   - parmi les sites AUTORISÉS de l'employé, on retient le plus proche, et on
--     accepte s'il entre dans le rayon de CE site ;
--   - le retard est calculé depuis l'horaire affecté, avec sa tolérance.
--
-- Le rayon et les seuils sont ceux configurés dans le Cockpit RH, figés dans la
-- ligne de pointage : modifier un rayon demain ne réécrit pas l'historique.
-- =============================================================================

ALTER TABLE public.attendances
    ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.work_schedules(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS late_minutes INT,
    ADD COLUMN IF NOT EXISTS tolerance_at_punch INT;

CREATE OR REPLACE FUNCTION public.record_attendance(
    p_punch_type      VARCHAR,
    p_latitude        DOUBLE PRECISION,
    p_longitude       DOUBLE PRECISION,
    p_gps_accuracy    DOUBLE PRECISION,
    p_selfie_path     TEXT DEFAULT NULL,
    p_face_score      NUMERIC DEFAULT NULL,
    p_device_ua       TEXT DEFAULT NULL,
    p_client_time     TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid          UUID := auth.uid();
    v_user         public.users%ROWTYPE;
    v_company      public.companies%ROWTYPE;
    v_site         public.geofences%ROWTYPE;
    v_sched        public.work_schedules%ROWTYPE;
    v_now          TIMESTAMP WITH TIME ZONE := NOW();
    v_local        TIMESTAMP := (NOW() AT TIME ZONE 'Africa/Abidjan');
    v_today        DATE := v_local::date;
    v_open         public.attendances%ROWTYPE;
    v_last         public.attendances%ROWTYPE;
    v_distance     DOUBLE PRECISION;
    v_att_id       UUID;
    v_needs_selfie BOOLEAN;
    v_face_ok      BOOLEAN := NULL;
    v_required     BOOLEAN;
    v_late         INT := NULL;
    v_status       VARCHAR(50) := 'on_time';
    v_code         VARCHAR(60) := NULL;
    v_detail       TEXT;
BEGIN
    -- 1. Identité, strictement issue de la session -----------------------------
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous pour pointer.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'EMPLOYEE_NOT_FOUND',
            'message', 'Votre fiche employé est introuvable. Contactez votre service RH.');
    END IF;

    IF NOT COALESCE(v_user.is_active, TRUE) THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'EMPLOYEE_INACTIVE',
            'message', 'Votre compte employé est désactivé. Contactez votre service RH.');
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;
    IF NOT FOUND OR v_company.status IN ('suspended', 'expired') THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'COMPANY_SUSPENDED',
            'message', 'Le compte de votre entreprise est suspendu.');
    END IF;

    v_required := COALESCE(
        v_user.attendance_required,
        (SELECT m.attendance_required FROM public.company_memberships m
          WHERE m.user_id = v_user.id AND m.company_id = v_user.company_id),
        TRUE);

    IF NOT v_required THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'ATTENDANCE_NOT_REQUIRED',
            'message', 'Votre poste n''est pas soumis au pointage.');
    END IF;

    IF p_punch_type NOT IN ('CHECK_IN', 'CHECK_OUT') THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'INVALID_PUNCH_TYPE',
            'message', 'Type de pointage invalide.');
    END IF;

    -- 2. Doublons et cohérence de la journée -----------------------------------
    SELECT * INTO v_last FROM public.attendances
     WHERE user_id = v_user.id AND company_id = v_user.company_id AND decision = 'ACCEPTED'
     ORDER BY server_time DESC LIMIT 1;

    IF FOUND AND v_last.server_time > v_now - make_interval(secs => COALESCE(v_company.min_punch_interval_sec, 60)) THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'DUPLICATE_PUNCH',
            'message', 'Un pointage vient déjà d''être enregistré. Patientez un instant.');
    END IF;

    SELECT * INTO v_open FROM public.attendances
     WHERE user_id = v_user.id AND company_id = v_user.company_id
       AND decision = 'ACCEPTED' AND punch_type = 'CHECK_IN' AND clock_out IS NULL
       AND (server_time AT TIME ZONE 'Africa/Abidjan')::date = v_today
     ORDER BY server_time DESC LIMIT 1;

    IF p_punch_type = 'CHECK_IN' AND v_open.id IS NOT NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'ALREADY_CHECKED_IN',
            'message', 'Votre arrivée a déjà été enregistrée aujourd''hui.');
    END IF;

    IF p_punch_type = 'CHECK_OUT' AND v_open.id IS NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'NO_OPEN_CHECK_IN',
            'message', 'Aucune arrivée n''a été enregistrée aujourd''hui.');
    END IF;

    -- 3. Contrôles GPS de base --------------------------------------------------
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        v_code := 'NO_LOCATION'; v_detail := 'Coordonnées absentes.';
    ELSIF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
        v_code := 'INVALID_COORDINATES'; v_detail := 'Coordonnées hors bornes.';
    ELSIF p_gps_accuracy IS NULL OR p_gps_accuracy <= 0 THEN
        v_code := 'NO_ACCURACY'; v_detail := 'Précision GPS non fournie.';
    ELSIF p_gps_accuracy > COALESCE(v_company.max_gps_accuracy_m, 100) THEN
        v_code := 'GPS_TOO_IMPRECISE';
        v_detail := format('Précision de %s m, maximum autorisé %s m.',
                    round(p_gps_accuracy::numeric, 0), COALESCE(v_company.max_gps_accuracy_m, 100));
    END IF;

    -- 4. Site LE PLUS PROCHE parmi ceux autorisés -------------------------------
    -- Filtré sur company_id : un employé ne peut jamais atteindre le site d'une
    -- autre entreprise, quoi qu'il envoie dans sa requête.
    IF v_code IS NULL THEN
        SELECT g.*, public.haversine_meters(p_latitude, p_longitude, g.latitude, g.longitude) AS d
          INTO v_site
          FROM public.geofences g
         WHERE g.company_id = v_user.company_id
           AND COALESCE(g.is_active, TRUE)
           AND g.latitude IS NOT NULL AND g.longitude IS NOT NULL
           AND (g.id = v_user.site_id
                OR g.id IN (SELECT es.site_id FROM public.employee_sites es WHERE es.user_id = v_user.id))
         ORDER BY public.haversine_meters(p_latitude, p_longitude, g.latitude, g.longitude) ASC
         LIMIT 1;

        IF v_site.id IS NULL THEN
            v_code := 'NO_SITE_ASSIGNED';
            v_detail := 'Aucun site de travail géolocalisé ne vous est affecté.';
        ELSE
            v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
            IF v_distance > v_site.radius_meters AND NOT COALESCE(v_company.allow_out_of_zone, FALSE) THEN
                v_code := 'OUTSIDE_GEOFENCE';
                v_detail := format('À %s m du site, rayon autorisé %s m.',
                            round(v_distance::numeric, 0), v_site.radius_meters);
            END IF;
        END IF;
    END IF;

    -- 5. Selfie ----------------------------------------------------------------
    v_needs_selfie := COALESCE(v_company.attendance_method, 'GPS_SELFIE') IN ('GPS_SELFIE', 'GPS_SELFIE_QR');

    IF v_code IS NULL AND v_needs_selfie AND (p_selfie_path IS NULL OR length(trim(p_selfie_path)) = 0) THEN
        v_code := 'SELFIE_REQUIRED'; v_detail := 'Selfie obligatoire pour cette entreprise.';
    END IF;

    IF v_code IS NULL AND COALESCE(v_company.face_verification_enabled, FALSE) THEN
        IF p_face_score IS NULL THEN
            v_code := 'FACE_NOT_VERIFIED'; v_detail := 'Score facial absent.';
        ELSIF p_face_score < COALESCE(v_company.face_match_threshold, 75) THEN
            v_face_ok := FALSE; v_code := 'FACE_MISMATCH';
            v_detail := format('Score facial %s %%, seuil %s %%.',
                        round(p_face_score, 1), COALESCE(v_company.face_match_threshold, 75));
        ELSE
            v_face_ok := TRUE;
        END IF;
    END IF;

    -- 6. Refus : on trace la tentative, jamais une présence ---------------------
    IF v_code IS NOT NULL THEN
        INSERT INTO public.attendance_attempts (
            company_id, user_id, site_id, punch_type, rejection_code, rejection_detail,
            latitude, longitude, gps_accuracy_meters, distance_from_site_m, allowed_radius_m,
            face_verification_score, selfie_path, device_user_agent, server_time)
        VALUES (
            v_user.company_id, v_user.id, v_site.id, p_punch_type, v_code, v_detail,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            p_face_score, p_selfie_path, p_device_ua, v_now);

        RETURN jsonb_build_object('accepted', FALSE, 'code', v_code, 'message', v_detail,
            'distance_m', round(v_distance::numeric, 0), 'radius_m', v_site.radius_meters,
            'accuracy_m', round(p_gps_accuracy::numeric, 0), 'site_name', v_site.name);
    END IF;

    -- 7. Retard, calculé depuis l'horaire configuré par le RH --------------------
    IF v_user.schedule_id IS NOT NULL THEN
        SELECT * INTO v_sched FROM public.work_schedules
         WHERE id = v_user.schedule_id AND company_id = v_user.company_id;
    END IF;

    IF p_punch_type = 'CHECK_IN' AND v_sched.id IS NOT NULL THEN
        v_late := GREATEST(
            0,
            (EXTRACT(HOUR FROM v_local)::INT * 60 + EXTRACT(MINUTE FROM v_local)::INT)
              - v_sched.start_minute - COALESCE(v_sched.tolerance_minutes, 0));
        IF v_late > 0 THEN v_status := 'late'; END IF;
    END IF;

    -- 8. Acceptation ------------------------------------------------------------
    IF p_punch_type = 'CHECK_OUT' THEN
        UPDATE public.attendances SET clock_out = v_now, updated_at = v_now WHERE id = v_open.id;
    END IF;

    INSERT INTO public.attendances (
        company_id, user_id, geofence_id, site_id, schedule_id,
        method, status, punch_type, clock_in, clock_out, server_time,
        latitude, longitude, gps_accuracy_meters,
        distance_from_site_m, allowed_radius_m, max_accuracy_m_at_punch,
        late_minutes, tolerance_at_punch,
        selfie_path, face_verified, face_verification_score, face_threshold_at_punch,
        decision, device_user_agent, device_platform, attendance_method_used, is_fake_gps_detected)
    VALUES (
        v_user.company_id, v_user.id, v_site.id, v_site.id, v_sched.id,
        CASE WHEN v_needs_selfie THEN 'face_id' ELSE 'gps' END,
        v_status, p_punch_type,
        CASE WHEN p_punch_type = 'CHECK_IN' THEN v_now ELSE v_open.clock_in END,
        CASE WHEN p_punch_type = 'CHECK_OUT' THEN v_now ELSE NULL END,
        v_now,
        p_latitude, p_longitude, p_gps_accuracy,
        round(v_distance::numeric, 2), v_site.radius_meters,
        COALESCE(v_company.max_gps_accuracy_m, 100),
        v_late, v_sched.tolerance_minutes,
        p_selfie_path, v_face_ok, p_face_score, v_company.face_match_threshold,
        'ACCEPTED', p_device_ua, 'WEB', COALESCE(v_company.attendance_method, 'GPS_SELFIE'), FALSE)
    RETURNING id INTO v_att_id;

    RETURN jsonb_build_object(
        'accepted', TRUE, 'code', 'ACCEPTED', 'attendance_id', v_att_id,
        'punch_type', p_punch_type,
        'server_time', to_char(v_local, 'HH24:MI:SS'),
        'server_date', to_char(v_local, 'DD/MM/YYYY'),
        'distance_m', round(v_distance::numeric, 0),
        'radius_m', v_site.radius_meters,
        'accuracy_m', round(p_gps_accuracy::numeric, 0),
        'site_name', v_site.name,
        'late_minutes', v_late,
        'status', v_status,
        'face_verified', v_face_ok);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_attendance(VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE) TO authenticated;


-- =============================================================================
-- 7. QUI PEUT CONFIGURER ?
--
-- Un EMPLOYEE ne doit jamais pouvoir modifier la latitude d'un site, un rayon,
-- son horaire ou son obligation de pointer en manipulant une requête. Les
-- politiques d'écriture sont donc réservées aux rôles du Cockpit RH.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_company_configurator()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid()
          AND upper(u.role) IN ('SUPER_ADMIN', 'COMPANY_ADMIN', 'CEO', 'HR')
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_company_configurator() TO authenticated;

-- --- Sites -------------------------------------------------------------------
DROP POLICY IF EXISTS "Public & Anon access on geofences" ON public.geofences;

DROP POLICY IF EXISTS "geofences_select_company" ON public.geofences;
CREATE POLICY "geofences_select_company" ON public.geofences
FOR SELECT TO authenticated
USING (company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid()));

DROP POLICY IF EXISTS "geofences_write_configurator" ON public.geofences;
CREATE POLICY "geofences_write_configurator" ON public.geofences
FOR ALL TO authenticated
USING (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
)
WITH CHECK (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
);

-- --- Horaires ----------------------------------------------------------------
DROP POLICY IF EXISTS "schedules_select_company" ON public.work_schedules;
CREATE POLICY "schedules_select_company" ON public.work_schedules
FOR SELECT TO authenticated
USING (company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid()));

DROP POLICY IF EXISTS "schedules_write_configurator" ON public.work_schedules;
CREATE POLICY "schedules_write_configurator" ON public.work_schedules
FOR ALL TO authenticated
USING (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
)
WITH CHECK (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
);

-- --- Sites additionnels ------------------------------------------------------
DROP POLICY IF EXISTS "employee_sites_select_company" ON public.employee_sites;
CREATE POLICY "employee_sites_select_company" ON public.employee_sites
FOR SELECT TO authenticated
USING (company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid()));

DROP POLICY IF EXISTS "employee_sites_write_configurator" ON public.employee_sites;
CREATE POLICY "employee_sites_write_configurator" ON public.employee_sites
FOR ALL TO authenticated
USING (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
)
WITH CHECK (
    company_id IN (SELECT u.company_id FROM public.users u WHERE u.id = auth.uid())
    AND public.is_company_configurator()
);
