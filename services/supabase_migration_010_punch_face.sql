-- =============================================================================
-- Winner Pointage — Migration 010 : vérification faciale au pointage
--
-- Idempotente. A executer apres la migration 009.
--
-- record_attendance accepte desormais p_face_descriptor : l'empreinte calculee
-- par le navigateur au moment du selfie. Le SERVEUR la compare a l'empreinte de
-- reference et decide. Le client ne transmet plus jamais de score.
--
-- L'ancien parametre p_face_score est conserve pour compatibilite mais N'EST
-- PLUS PRIS EN COMPTE dans la decision : il etait falsifiable par construction.
-- =============================================================================

DROP FUNCTION IF EXISTS public.record_attendance(
    VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE, TEXT);

DROP FUNCTION IF EXISTS public.record_attendance(
    VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE, TEXT,
    DOUBLE PRECISION[], NUMERIC);

CREATE OR REPLACE FUNCTION public.record_attendance(
    p_punch_type      VARCHAR,
    p_latitude        DOUBLE PRECISION,
    p_longitude       DOUBLE PRECISION,
    p_gps_accuracy    DOUBLE PRECISION,
    p_selfie_path     TEXT DEFAULT NULL,
    p_face_score      NUMERIC DEFAULT NULL,
    p_device_ua       TEXT DEFAULT NULL,
    p_client_time     TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_qr_token        TEXT DEFAULT NULL,
    p_face_descriptor DOUBLE PRECISION[] DEFAULT NULL,
    p_face_motion     NUMERIC DEFAULT NULL,
    p_challenge_id    UUID DEFAULT NULL,
    p_liveness        JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid          UUID := auth.uid();
    v_user         public.users%ROWTYPE;
    v_company      public.companies%ROWTYPE;
    v_site         public.geofences%ROWTYPE;
    v_sched        public.work_schedules%ROWTYPE;
    v_tpl          public.face_templates%ROWTYPE;
    v_now          TIMESTAMP WITH TIME ZONE := NOW();
    v_local        TIMESTAMP := (NOW() AT TIME ZONE 'Africa/Abidjan');
    v_today        DATE := v_local::date;
    v_open         public.attendances%ROWTYPE;
    v_last         public.attendances%ROWTYPE;
    v_distance     DOUBLE PRECISION;
    v_att_id       UUID;
    v_needs_selfie BOOLEAN;
    v_face_ok      BOOLEAN := NULL;
    v_face_dist    DOUBLE PRECISION := NULL;
    v_face_pct     NUMERIC := NULL;
    v_max_dist     NUMERIC;
    v_required     BOOLEAN;
    v_late         INT := NULL;
    v_status       VARCHAR(50) := 'on_time';
    v_decision     VARCHAR(20) := 'ACCEPTED';
    v_code         VARCHAR(60) := NULL;
    v_detail       TEXT;
    v_qr           JSONB;
    v_method       VARCHAR(50);
    v_review       TEXT := NULL;
    v_live         JSONB;
BEGIN
    -- 1. Identite ---------------------------------------------------------------
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

    -- 2. Doublons et coherence de la journee -----------------------------------
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

    -- 3. Controles GPS ----------------------------------------------------------
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

    -- 4. VERIFICATION FACIALE — calculee ICI, jamais par le client ---------------
    --
    -- Placee AVANT la validation du QR, volontairement : qr_validate()
    -- consomme le jeton (anti-rejeu). Si l identite echouait apres, le code
    -- affiche sur la borne serait brule et l employe ne pourrait pas
    -- reessayer avant la rotation suivante.
    --
    -- Elle s applique AUSSI au pointage par QR code. Le jeton QR prouve la
    -- presence devant la borne ; il ne prouve pas QUI tient le telephone. Un
    -- salarie pourrait confier son appareil deverrouille a un collegue et se
    -- faire pointer a distance. Quand l entreprise exige l identite, elle
    -- l exige sur tous les chemins de pointage, sans exception.
    IF v_code IS NULL AND COALESCE(v_company.face_verification_enabled, FALSE) THEN

        SELECT * INTO v_tpl FROM public.face_templates WHERE user_id = v_user.id;

        IF NOT FOUND THEN
            -- On ne bloque pas sur une reference que l'employe n'a jamais pu
            -- enregistrer : on le lui dit clairement, c'est une action a sa portee.
            v_code := 'FACE_NOT_ENROLLED';
            v_detail := 'Aucun visage de référence enregistré pour votre compte.';

        ELSIF p_face_descriptor IS NULL OR array_length(p_face_descriptor, 1) <> 128 THEN
            v_code := 'FACE_NOT_CAPTURED';
            v_detail := 'Aucun visage exploitable n''a été détecté sur la photo.';

        ELSIF v_tpl.model_version IS DISTINCT FROM 'face-api-1.7.15/128' THEN
            -- Deux versions de modele produisent des vecteurs incomparables.
            v_code := 'FACE_MODEL_MISMATCH';
            v_detail := 'Votre visage de référence doit être réenregistré.';

        ELSE
            v_max_dist  := COALESCE(v_company.face_max_distance, 0.550);
            v_face_dist := public.face_distance(v_tpl.descriptor, p_face_descriptor);
            -- Pourcentage indicatif, pour l'affichage uniquement. La DECISION
            -- porte sur la distance, l'unite naturelle du modele.
            -- Cast explicite : PostgreSQL n'a pas de round(double precision, int).
            v_face_pct  := round((GREATEST(0, (1 - v_face_dist)) * 100)::numeric, 1);

            IF v_face_dist IS NULL THEN
                v_code := 'FACE_NOT_CAPTURED';
                v_detail := 'Empreinte faciale illisible.';
            ELSIF v_face_dist > v_max_dist THEN
                v_face_ok := FALSE;
                v_code := 'FACE_MISMATCH';
                v_detail := format('Le visage capturé ne correspond pas à la référence (écart %s, maximum %s).',
                            round(v_face_dist::numeric, 3), v_max_dist);
            ELSE
                v_face_ok := TRUE;

                -- ---------------------------------------------------------------
                -- VIVACITE : le visage correspond, mais est-il VIVANT ?
                --
                -- Sans ce controle, une photographie du bon visage passe. C est
                -- ici, et seulement ici, que la photo brandie est arretee.
                -- Voir la migration 011 pour le detail des mesures.
                -- ---------------------------------------------------------------
                IF COALESCE(v_company.face_liveness_enabled, TRUE) THEN
                    IF p_challenge_id IS NULL THEN
                        v_face_ok := NULL;
                        v_code := 'LIVENESS_REQUIRED';
                        v_detail := 'Le contrôle anti-photo n''a pas été effectué.';
                    ELSE
                        v_live := public.validate_liveness(
                            p_challenge_id, v_user.id, p_liveness,
                            v_tpl.descriptor, v_max_dist);

                        IF NOT (v_live->>'ok')::boolean THEN
                            v_face_ok := NULL;
                            v_code := v_live->>'code';
                            v_detail := v_live->>'detail';
                        END IF;
                    END IF;
                END IF;

                -- Signal de mouvement, conserve comme motif de revue humaine.
                -- Il n a jamais ete un test de vivacite ; celui-ci est au-dessus.
                IF v_code IS NULL AND p_face_motion IS NOT NULL
                   AND p_face_motion <= COALESCE(v_company.face_min_motion, 0) THEN
                    v_decision := 'PENDING_REVIEW';
                    v_review := 'Mouvement du visage très faible entre les prises : vérification humaine recommandée.';
                END IF;
            END IF;
        END IF;
    END IF;

    -- 5. QR : le jeton impose le site -------------------------------------------
    IF v_code IS NULL AND p_qr_token IS NOT NULL AND length(trim(p_qr_token)) > 0 THEN
        v_qr := public.qr_validate(p_qr_token, v_user.id);
        IF NOT (v_qr->>'ok')::boolean THEN
            v_code := v_qr->>'code';
            v_detail := CASE v_code
                WHEN 'QR_EXPIRED' THEN 'Ce QR code n''est plus valable. Scannez celui affiché maintenant.'
                WHEN 'QR_REPLAY'  THEN 'Ce QR code a déjà servi à un pointage.'
                WHEN 'QR_FORGED'  THEN 'Ce QR code ne provient pas d''un poste de votre entreprise.'
                ELSE 'QR code invalide.'
            END;
        ELSE
            SELECT * INTO v_site FROM public.geofences
             WHERE id = (v_qr->>'site_id')::uuid AND company_id = v_user.company_id;
            IF NOT FOUND THEN
                v_code := 'QR_FORGED';
                v_detail := 'Ce QR code appartient à une autre entreprise.';
            END IF;
        END IF;
    END IF;

    -- 6. Sans QR : site le plus proche parmi ceux autorises ---------------------
    IF v_code IS NULL AND v_site.id IS NULL THEN
        SELECT g.* INTO v_site
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
        END IF;
    END IF;

    -- 7. Geofencing --------------------------------------------------------------
    IF v_code IS NULL AND v_site.id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
        IF v_distance > v_site.radius_meters AND NOT COALESCE(v_company.allow_out_of_zone, FALSE) THEN
            v_code := 'OUTSIDE_GEOFENCE';
            v_detail := format('À %s m du site, rayon autorisé %s m.',
                        round(v_distance::numeric, 0), v_site.radius_meters);
        END IF;
    END IF;

    -- 8. Selfie ------------------------------------------------------------------
    v_needs_selfie := COALESCE(v_company.attendance_method, 'GPS_SELFIE') IN ('GPS_SELFIE', 'GPS_SELFIE_QR')
                      AND (p_qr_token IS NULL OR length(trim(p_qr_token)) = 0);

    IF v_code IS NULL AND v_needs_selfie AND (p_selfie_path IS NULL OR length(trim(p_selfie_path)) = 0) THEN
        v_code := 'SELFIE_REQUIRED'; v_detail := 'Selfie obligatoire pour cette entreprise.';
    END IF;

    -- 9. Refus : on trace la tentative ------------------------------------------
    IF v_code IS NOT NULL THEN
        INSERT INTO public.attendance_attempts (
            company_id, user_id, site_id, punch_type, rejection_code, rejection_detail,
            latitude, longitude, gps_accuracy_meters, distance_from_site_m, allowed_radius_m,
            face_verification_score, selfie_path, device_user_agent, server_time)
        VALUES (
            v_user.company_id, v_user.id, v_site.id, p_punch_type, v_code, v_detail,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            v_face_pct, p_selfie_path, p_device_ua, v_now);

        RETURN jsonb_build_object('accepted', FALSE, 'code', v_code, 'message', v_detail,
            'distance_m', round(v_distance::numeric, 0), 'radius_m', v_site.radius_meters,
            'accuracy_m', round(p_gps_accuracy::numeric, 0), 'site_name', v_site.name,
            'face_distance', round(v_face_dist::numeric, 3), 'face_similarity', v_face_pct);
    END IF;

    -- 10. Retard -----------------------------------------------------------------
    IF v_user.schedule_id IS NOT NULL THEN
        SELECT * INTO v_sched FROM public.work_schedules
         WHERE id = v_user.schedule_id AND company_id = v_user.company_id;
    END IF;

    IF p_punch_type = 'CHECK_IN' AND v_sched.id IS NOT NULL THEN
        v_late := GREATEST(0,
            (EXTRACT(HOUR FROM v_local)::INT * 60 + EXTRACT(MINUTE FROM v_local)::INT)
              - v_sched.start_minute - COALESCE(v_sched.tolerance_minutes, 0));
        IF v_late > 0 THEN v_status := 'late'; END IF;
    END IF;

    -- 11. Acceptation -------------------------------------------------------------
    v_method := CASE
        WHEN p_qr_token IS NOT NULL AND length(trim(p_qr_token)) > 0 THEN 'qr_kiosk'
        WHEN v_face_ok IS TRUE THEN 'face_id'
        WHEN p_selfie_path IS NOT NULL THEN 'face_id'
        ELSE 'gps'
    END;

    IF p_punch_type = 'CHECK_OUT' AND v_decision = 'ACCEPTED' THEN
        UPDATE public.attendances SET clock_out = v_now, updated_at = v_now WHERE id = v_open.id;
    END IF;

    INSERT INTO public.attendances (
        company_id, user_id, geofence_id, site_id, schedule_id,
        method, status, punch_type, clock_in, clock_out, server_time,
        latitude, longitude, gps_accuracy_meters,
        distance_from_site_m, allowed_radius_m, max_accuracy_m_at_punch,
        late_minutes, tolerance_at_punch,
        selfie_path, face_verified, face_verification_score, face_threshold_at_punch,
        decision, review_note, device_user_agent, device_platform,
        attendance_method_used, is_fake_gps_detected)
    VALUES (
        v_user.company_id, v_user.id, v_site.id, v_site.id, v_sched.id,
        v_method, v_status, p_punch_type,
        CASE WHEN p_punch_type = 'CHECK_IN' THEN v_now ELSE v_open.clock_in END,
        CASE WHEN p_punch_type = 'CHECK_OUT' THEN v_now ELSE NULL END,
        v_now,
        p_latitude, p_longitude, p_gps_accuracy,
        round(v_distance::numeric, 2), v_site.radius_meters,
        COALESCE(v_company.max_gps_accuracy_m, 100),
        v_late, v_sched.tolerance_minutes,
        p_selfie_path, v_face_ok, v_face_pct, (COALESCE(v_company.face_max_distance, 0.550) * 100),
        v_decision, v_review, p_device_ua, 'WEB',
        COALESCE(v_company.attendance_method, 'GPS_SELFIE'), FALSE)
    RETURNING id INTO v_att_id;

    RETURN jsonb_build_object(
        'accepted', (v_decision = 'ACCEPTED'), 'code', v_decision,
        'attendance_id', v_att_id, 'punch_type', p_punch_type, 'method', v_method,
        'server_time', to_char(v_local, 'HH24:MI:SS'),
        'server_date', to_char(v_local, 'DD/MM/YYYY'),
        'distance_m', round(v_distance::numeric, 0),
        'radius_m', v_site.radius_meters,
        'accuracy_m', round(p_gps_accuracy::numeric, 0),
        'site_name', v_site.name,
        'late_minutes', v_late,
        'status', v_status,
        'face_verified', v_face_ok,
        'face_distance', round(v_face_dist::numeric, 3),
        'face_similarity', v_face_pct,
        'review_note', v_review);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_attendance(
    VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
    TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE, TEXT,
    DOUBLE PRECISION[], NUMERIC, UUID, JSONB) TO authenticated;
