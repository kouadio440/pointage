-- =============================================================================
-- Winner Pointage — Migration 002 : Pointage sécurisé Selfie + GPS
--
-- À exécuter dans l'éditeur SQL Supabase APRÈS supabase_schema.sql.
-- Idempotente : peut être rejouée sans dommage.
--
-- PRINCIPE CENTRAL
-- ----------------
-- La décision d'accepter ou refuser un pointage appartient au SERVEUR, jamais
-- au navigateur. Tout passe par la fonction record_attendance() ci-dessous,
-- déclarée SECURITY DEFINER, et les politiques RLS interdisent désormais au
-- client d'écrire directement dans public.attendances.
--
-- Sans ce verrouillage, la RPC serait décorative : n'importe qui disposant de
-- la clé anon (elle est publique par nature) pourrait insérer un pointage
-- « accepté » à la main depuis la console du navigateur.
-- =============================================================================


-- =============================================================================
-- 1. SITES DE TRAVAIL
--
-- La table geofences existe déjà et porte latitude/longitude/radius_meters.
-- On la complète plutôt que de créer une table « sites » concurrente : les
-- données de géofencing y sont déjà, et dupliquer produirait deux vérités.
-- =============================================================================

ALTER TABLE public.geofences
    ADD COLUMN IF NOT EXISTS address TEXT,
    ADD COLUMN IF NOT EXISTS is_headquarters BOOLEAN DEFAULT FALSE;

-- Rayon autorisé : garde-fous de bon sens. Un rayon de 5 km viderait le
-- géofencing de son sens ; un rayon de 5 m rendrait le pointage impossible
-- compte tenu de la précision GPS réelle d'un téléphone.
ALTER TABLE public.geofences
    DROP CONSTRAINT IF EXISTS geofences_radius_sane;
ALTER TABLE public.geofences
    ADD CONSTRAINT geofences_radius_sane
    CHECK (radius_meters BETWEEN 20 AND 5000);

-- Affectation de l'employé à son site. Le pointage s'évalue contre CE site.
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_site ON public.users(company_id, site_id);


-- =============================================================================
-- 2. CONFIGURATION DU POINTAGE PAR ENTREPRISE
--
-- Prépare le choix demandé côté Cockpit RH : GPS seul, GPS + selfie, et plus
-- tard GPS + selfie + QR. La valeur par défaut est GPS_SELFIE, conformément au
-- fonctionnement attendu aujourd'hui.
-- =============================================================================

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS attendance_method VARCHAR(30) DEFAULT 'GPS_SELFIE',
    ADD COLUMN IF NOT EXISTS max_gps_accuracy_m INT DEFAULT 100,
    ADD COLUMN IF NOT EXISTS face_match_threshold NUMERIC(5,2) DEFAULT 75.00,
    ADD COLUMN IF NOT EXISTS min_punch_interval_sec INT DEFAULT 60,
    -- Tant qu'aucun service de vérification faciale réel n'est branché, le
    -- selfie est CAPTURÉ et CONSERVÉ comme preuve, mais ne peut pas bloquer un
    -- pointage : refuser sur la foi d'une IA inexistante serait un mensonge.
    ADD COLUMN IF NOT EXISTS face_verification_enabled BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS liveness_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE public.companies
    DROP CONSTRAINT IF EXISTS companies_attendance_method_check;
ALTER TABLE public.companies
    ADD CONSTRAINT companies_attendance_method_check
    CHECK (attendance_method IN ('GPS_ONLY', 'GPS_SELFIE', 'GPS_SELFIE_QR'));


-- =============================================================================
-- 3. EXTENSION DU REGISTRE DES POINTAGES
--
-- Chaque ligne doit permettre au RH de comprendre, des mois plus tard, POURQUOI
-- ce pointage a été accepté ou refusé. On conserve donc les valeurs mesurées
-- (distance, précision) ET les seuils en vigueur AU MOMENT du pointage :
-- si le rayon du site change demain, l'historique reste interprétable.
-- =============================================================================

ALTER TABLE public.attendances
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS punch_type VARCHAR(20),
    ADD COLUMN IF NOT EXISTS server_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS distance_from_site_m NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS allowed_radius_m INT,
    ADD COLUMN IF NOT EXISTS max_accuracy_m_at_punch INT,
    ADD COLUMN IF NOT EXISTS selfie_path TEXT,
    ADD COLUMN IF NOT EXISTS face_verified BOOLEAN,
    ADD COLUMN IF NOT EXISTS face_verification_score NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS face_threshold_at_punch NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS liveness_passed BOOLEAN,
    ADD COLUMN IF NOT EXISTS decision VARCHAR(20) DEFAULT 'ACCEPTED',
    ADD COLUMN IF NOT EXISTS device_user_agent TEXT,
    ADD COLUMN IF NOT EXISTS device_platform VARCHAR(30) DEFAULT 'WEB',
    ADD COLUMN IF NOT EXISTS attendance_method_used VARCHAR(30),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

ALTER TABLE public.attendances
    DROP CONSTRAINT IF EXISTS attendances_punch_type_check;
ALTER TABLE public.attendances
    ADD CONSTRAINT attendances_punch_type_check
    CHECK (punch_type IS NULL OR punch_type IN ('CHECK_IN', 'CHECK_OUT'));

ALTER TABLE public.attendances
    DROP CONSTRAINT IF EXISTS attendances_decision_check;
ALTER TABLE public.attendances
    ADD CONSTRAINT attendances_decision_check
    CHECK (decision IN ('ACCEPTED', 'PENDING_REVIEW', 'REJECTED'));

CREATE INDEX IF NOT EXISTS idx_attendances_company_day
    ON public.attendances(company_id, (server_time::date));
CREATE INDEX IF NOT EXISTS idx_attendances_user_day
    ON public.attendances(company_id, user_id, (server_time::date));


-- =============================================================================
-- 4. TENTATIVES DE POINTAGE
--
-- Une tentative refusée n'est PAS un pointage. Elle est enregistrée séparément
-- afin que le RH voie qu'un employé a essayé (et pourquoi il a échoué), sans
-- qu'un refus puisse jamais se transformer en présence validée.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.attendance_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    site_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL,

    punch_type VARCHAR(20),
    rejection_code VARCHAR(60) NOT NULL,
    rejection_detail TEXT,

    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    gps_accuracy_meters DOUBLE PRECISION,
    distance_from_site_m NUMERIC(10,2),
    allowed_radius_m INT,

    face_verification_score NUMERIC(5,2),
    selfie_path TEXT,

    device_user_agent TEXT,
    server_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attempts_company_time
    ON public.attendance_attempts(company_id, server_time DESC);

ALTER TABLE public.attendance_attempts ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 5. CALCUL DE DISTANCE — HAVERSINE
--
-- IMMUTABLE : le résultat ne dépend que des arguments, ce qui permet à
-- PostgreSQL de l'optimiser et garantit qu'un même couple de coordonnées
-- donnera toujours la même distance, y compris lors d'un réexamen a posteriori.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.haversine_meters(
    lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    r CONSTANT DOUBLE PRECISION := 6371008.8;  -- rayon moyen WGS-84, en mètres
    d_lat DOUBLE PRECISION;
    d_lon DOUBLE PRECISION;
    a DOUBLE PRECISION;
BEGIN
    IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
        RETURN NULL;
    END IF;

    d_lat := radians(lat2 - lat1);
    d_lon := radians(lon2 - lon1);

    a := sin(d_lat / 2) ^ 2
       + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ^ 2;

    RETURN 2 * r * asin(least(1, sqrt(a)));
END;
$$;


-- =============================================================================
-- 6. LA FONCTION DE POINTAGE
--
-- Point d'entrée UNIQUE. Le client ne fournit que des MESURES (position,
-- précision, chemin du selfie). Il ne fournit jamais de verdict, ni son
-- company_id, ni son site : le serveur les déduit de l'utilisateur authentifié.
--
-- C'est ce qui empêche un employé de l'Entreprise A de pointer sur un site de
-- l'Entreprise B en manipulant la requête : le site_id envoyé par le client
-- est purement et simplement ignoré.
-- =============================================================================

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
    v_auth_uid        UUID := auth.uid();
    v_user            public.users%ROWTYPE;
    v_company         public.companies%ROWTYPE;
    v_site            public.geofences%ROWTYPE;
    v_membership      public.company_memberships%ROWTYPE;

    v_distance        DOUBLE PRECISION;
    v_now             TIMESTAMP WITH TIME ZONE := NOW();
    v_today           DATE;
    v_last            public.attendances%ROWTYPE;
    v_open_checkin    public.attendances%ROWTYPE;
    v_attendance_id   UUID;
    v_requires_selfie BOOLEAN;
    v_face_ok         BOOLEAN := NULL;

    -- Enregistre une tentative refusée puis renvoie le verdict au client.
    -- Déclarée en variable pour garder un chemin de sortie unique et lisible.
    v_code            VARCHAR(60);
    v_detail          TEXT;
BEGIN
    ---------------------------------------------------------------------------
    -- 6.1 Identité : STRICTEMENT déduite de la session, jamais du client
    ---------------------------------------------------------------------------
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous pour pointer.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_auth_uid;
    IF NOT FOUND THEN
        SELECT * INTO v_user FROM public.users
        WHERE email = (SELECT email FROM auth.users WHERE id = v_auth_uid);
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'EMPLOYEE_NOT_FOUND',
            'message', 'Votre fiche employé est introuvable. Contactez votre service RH.');
    END IF;

    IF NOT COALESCE(v_user.is_active, TRUE) THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'EMPLOYEE_INACTIVE',
            'message', 'Votre compte employé est désactivé. Contactez votre service RH.');
    END IF;

    IF v_user.company_id IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'NO_COMPANY',
            'message', 'Aucune entreprise n''est rattachée à votre compte. Contactez votre service RH.');
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;
    IF NOT FOUND OR v_company.status IN ('suspended', 'expired') THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'COMPANY_SUSPENDED',
            'message', 'Le compte de votre entreprise est suspendu. Le pointage est momentanément indisponible.');
    END IF;

    ---------------------------------------------------------------------------
    -- 6.2 L'employé est-il soumis au pointage ?
    ---------------------------------------------------------------------------
    SELECT * INTO v_membership
    FROM public.company_memberships
    WHERE user_id = v_user.id AND company_id = v_user.company_id;

    IF FOUND THEN
        IF v_membership.status <> 'ACTIVE' THEN
            RETURN jsonb_build_object(
                'accepted', FALSE, 'code', 'MEMBERSHIP_NOT_ACTIVE',
                'message', 'Votre rattachement à l''entreprise n''est pas encore validé par le service RH.');
        END IF;
        IF NOT COALESCE(v_membership.attendance_required, TRUE) THEN
            RETURN jsonb_build_object(
                'accepted', FALSE, 'code', 'ATTENDANCE_NOT_REQUIRED',
                'message', 'Votre poste n''est pas soumis au pointage.');
        END IF;
    END IF;

    ---------------------------------------------------------------------------
    -- 6.3 Type de pointage et cohérence avec la journée en cours
    ---------------------------------------------------------------------------
    IF p_punch_type NOT IN ('CHECK_IN', 'CHECK_OUT') THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'INVALID_PUNCH_TYPE',
            'message', 'Type de pointage invalide.');
    END IF;

    v_today := (v_now AT TIME ZONE COALESCE(NULLIF(current_setting('app.tz', TRUE), ''), 'Africa/Abidjan'))::date;

    -- Anti double-clic : deux requêtes rapprochées ne créent qu'un pointage.
    SELECT * INTO v_last
    FROM public.attendances
    WHERE user_id = v_user.id AND company_id = v_user.company_id
      AND decision = 'ACCEPTED'
    ORDER BY server_time DESC
    LIMIT 1;

    IF FOUND AND v_last.server_time > v_now - make_interval(secs => COALESCE(v_company.min_punch_interval_sec, 60)) THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'DUPLICATE_PUNCH',
            'message', 'Un pointage vient déjà d''être enregistré. Patientez un instant.',
            'attendance_id', v_last.id);
    END IF;

    -- Arrivée du jour déjà ouverte ?
    SELECT * INTO v_open_checkin
    FROM public.attendances
    WHERE user_id = v_user.id AND company_id = v_user.company_id
      AND decision = 'ACCEPTED'
      AND punch_type = 'CHECK_IN'
      AND clock_out IS NULL
      AND (server_time AT TIME ZONE 'Africa/Abidjan')::date = v_today
    ORDER BY server_time DESC
    LIMIT 1;

    IF p_punch_type = 'CHECK_IN' AND v_open_checkin.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'ALREADY_CHECKED_IN',
            'message', 'Votre arrivée a déjà été enregistrée aujourd''hui.',
            'attendance_id', v_open_checkin.id);
    END IF;

    IF p_punch_type = 'CHECK_OUT' AND v_open_checkin.id IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'NO_OPEN_CHECK_IN',
            'message', 'Aucune arrivée n''a été enregistrée aujourd''hui. Signalez-le à votre service RH.');
    END IF;

    ---------------------------------------------------------------------------
    -- 6.4 Site de rattachement — choisi par le SERVEUR
    ---------------------------------------------------------------------------
    IF v_user.site_id IS NOT NULL THEN
        SELECT * INTO v_site FROM public.geofences
        WHERE id = v_user.site_id AND company_id = v_user.company_id;
    END IF;

    IF v_site.id IS NULL THEN
        -- Repli : site actif de l'entreprise, siège en priorité.
        SELECT * INTO v_site FROM public.geofences
        WHERE company_id = v_user.company_id AND COALESCE(is_active, TRUE)
        ORDER BY is_headquarters DESC NULLS LAST, created_at ASC
        LIMIT 1;
    END IF;

    IF v_site.id IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'NO_SITE_ASSIGNED',
            'message', 'Aucun site de travail n''est configuré pour votre entreprise. Contactez votre service RH.');
    END IF;

    IF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN
        RETURN jsonb_build_object(
            'accepted', FALSE, 'code', 'SITE_WITHOUT_COORDINATES',
            'message', 'Votre site de travail n''a pas encore de coordonnées GPS. Contactez votre service RH.');
    END IF;

    ---------------------------------------------------------------------------
    -- 6.5 Contrôles GPS — la mesure vient du client, la DÉCISION du serveur
    ---------------------------------------------------------------------------
    v_code := NULL;

    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        v_code := 'NO_LOCATION';
        v_detail := 'Coordonnées absentes de la requête.';
    ELSIF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
        v_code := 'INVALID_COORDINATES';
        v_detail := format('Coordonnées hors bornes : %s / %s', p_latitude, p_longitude);
    ELSIF p_gps_accuracy IS NULL OR p_gps_accuracy <= 0 THEN
        v_code := 'NO_ACCURACY';
        v_detail := 'Précision GPS non fournie.';
    ELSIF p_gps_accuracy > COALESCE(v_company.max_gps_accuracy_m, 100) THEN
        v_code := 'GPS_TOO_IMPRECISE';
        v_detail := format('Précision de %s m, maximum autorisé %s m.',
                           round(p_gps_accuracy::numeric, 0),
                           COALESCE(v_company.max_gps_accuracy_m, 100));
    END IF;

    IF v_code IS NULL THEN
        v_distance := public.haversine_meters(
            p_latitude, p_longitude, v_site.latitude, v_site.longitude);

        IF v_distance > v_site.radius_meters THEN
            v_code := 'OUTSIDE_GEOFENCE';
            v_detail := format('À %s m du site, rayon autorisé %s m.',
                               round(v_distance::numeric, 0), v_site.radius_meters);
        END IF;
    END IF;

    ---------------------------------------------------------------------------
    -- 6.6 Selfie et vérification faciale
    --
    -- On distingue nettement deux choses :
    --   - le selfie est OBLIGATOIRE si la méthode de l'entreprise l'exige ;
    --   - la vérification faciale ne peut REFUSER que si un service réel est
    --     branché (face_verification_enabled). Sinon le selfie est conservé
    --     comme preuve consultable par le RH, sans verdict automatique.
    --     Refuser sur la foi d'une IA inexistante serait un faux contrôle.
    ---------------------------------------------------------------------------
    v_requires_selfie := COALESCE(v_company.attendance_method, 'GPS_SELFIE') IN ('GPS_SELFIE', 'GPS_SELFIE_QR');

    IF v_code IS NULL AND v_requires_selfie AND (p_selfie_path IS NULL OR length(trim(p_selfie_path)) = 0) THEN
        v_code := 'SELFIE_REQUIRED';
        v_detail := 'Aucun selfie fourni alors que la méthode de pointage l''exige.';
    END IF;

    IF v_code IS NULL AND COALESCE(v_company.face_verification_enabled, FALSE) THEN
        IF p_face_score IS NULL THEN
            v_code := 'FACE_NOT_VERIFIED';
            v_detail := 'Score de vérification faciale absent.';
        ELSIF p_face_score < COALESCE(v_company.face_match_threshold, 75) THEN
            v_face_ok := FALSE;
            v_code := 'FACE_MISMATCH';
            v_detail := format('Score facial %s %%, seuil requis %s %%.',
                               round(p_face_score, 1), COALESCE(v_company.face_match_threshold, 75));
        ELSE
            v_face_ok := TRUE;
        END IF;
    END IF;

    ---------------------------------------------------------------------------
    -- 6.7 Refus : on trace la TENTATIVE, jamais une présence
    ---------------------------------------------------------------------------
    IF v_code IS NOT NULL THEN
        INSERT INTO public.attendance_attempts (
            company_id, user_id, site_id, punch_type,
            rejection_code, rejection_detail,
            latitude, longitude, gps_accuracy_meters,
            distance_from_site_m, allowed_radius_m,
            face_verification_score, selfie_path,
            device_user_agent, server_time
        ) VALUES (
            v_user.company_id, v_user.id, v_site.id, p_punch_type,
            v_code, v_detail,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            p_face_score, p_selfie_path,
            p_device_ua, v_now
        );

        RETURN jsonb_build_object(
            'accepted',    FALSE,
            'code',        v_code,
            'message',     v_detail,
            'distance_m',  round(v_distance::numeric, 0),
            'radius_m',    v_site.radius_meters,
            'accuracy_m',  round(p_gps_accuracy::numeric, 0),
            'site_name',   v_site.name
        );
    END IF;

    ---------------------------------------------------------------------------
    -- 6.8 Acceptation — l'heure officielle est CELLE DU SERVEUR
    ---------------------------------------------------------------------------
    IF p_punch_type = 'CHECK_IN' THEN
        INSERT INTO public.attendances (
            company_id, user_id, geofence_id, site_id,
            method, status, punch_type,
            clock_in, server_time,
            latitude, longitude, gps_accuracy_meters,
            distance_from_site_m, allowed_radius_m, max_accuracy_m_at_punch,
            selfie_path, face_verified, face_verification_score, face_threshold_at_punch,
            decision, device_user_agent, device_platform, attendance_method_used,
            is_fake_gps_detected
        ) VALUES (
            v_user.company_id, v_user.id, v_site.id, v_site.id,
            CASE WHEN v_requires_selfie THEN 'face_id' ELSE 'gps' END,
            'on_time', 'CHECK_IN',
            v_now, v_now,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            COALESCE(v_company.max_gps_accuracy_m, 100),
            p_selfie_path, v_face_ok, p_face_score, v_company.face_match_threshold,
            'ACCEPTED', p_device_ua, 'WEB', COALESCE(v_company.attendance_method, 'GPS_SELFIE'),
            FALSE
        )
        RETURNING id INTO v_attendance_id;
    ELSE
        UPDATE public.attendances
        SET clock_out  = v_now,
            updated_at = v_now
        WHERE id = v_open_checkin.id
        RETURNING id INTO v_attendance_id;

        -- Le départ est aussi conservé comme événement à part entière : il porte
        -- ses propres preuves (position, précision, selfie), qui peuvent différer
        -- de celles de l'arrivée.
        INSERT INTO public.attendances (
            company_id, user_id, geofence_id, site_id,
            method, status, punch_type,
            clock_in, clock_out, server_time,
            latitude, longitude, gps_accuracy_meters,
            distance_from_site_m, allowed_radius_m, max_accuracy_m_at_punch,
            selfie_path, face_verified, face_verification_score, face_threshold_at_punch,
            decision, device_user_agent, device_platform, attendance_method_used,
            is_fake_gps_detected
        ) VALUES (
            v_user.company_id, v_user.id, v_site.id, v_site.id,
            CASE WHEN v_requires_selfie THEN 'face_id' ELSE 'gps' END,
            'on_time', 'CHECK_OUT',
            v_open_checkin.clock_in, v_now, v_now,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            COALESCE(v_company.max_gps_accuracy_m, 100),
            p_selfie_path, v_face_ok, p_face_score, v_company.face_match_threshold,
            'ACCEPTED', p_device_ua, 'WEB', COALESCE(v_company.attendance_method, 'GPS_SELFIE'),
            FALSE
        )
        RETURNING id INTO v_attendance_id;
    END IF;

    RETURN jsonb_build_object(
        'accepted',      TRUE,
        'code',          'ACCEPTED',
        'attendance_id', v_attendance_id,
        'punch_type',    p_punch_type,
        -- Heure officielle, produite par le serveur. L'horloge du téléphone
        -- n'est jamais utilisée pour dater un pointage.
        'server_time',   to_char(v_now AT TIME ZONE 'Africa/Abidjan', 'HH24:MI:SS'),
        'server_date',   to_char(v_now AT TIME ZONE 'Africa/Abidjan', 'DD/MM/YYYY'),
        'distance_m',    round(v_distance::numeric, 0),
        'radius_m',      v_site.radius_meters,
        'accuracy_m',    round(p_gps_accuracy::numeric, 0),
        'site_name',     v_site.name,
        'face_verified', v_face_ok
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_attendance(VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_attendance(VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, NUMERIC, TEXT, TIMESTAMP WITH TIME ZONE) TO authenticated;


-- =============================================================================
-- 7. VERROUILLAGE RLS
--
-- Sans ce bloc, tout ce qui précède est décoratif : la clé anon est publique,
-- et n'importe qui pourrait insérer un pointage « ACCEPTED » depuis la console
-- du navigateur. On retire donc au client tout droit d'écriture directe sur
-- attendances : seule record_attendance() (SECURITY DEFINER) peut écrire.
-- =============================================================================

DROP POLICY IF EXISTS "Public & Anon access on attendances" ON public.attendances;

-- Lecture : chacun voit ses propres pointages ; le RH/CEO voit ceux de SON entreprise.
DROP POLICY IF EXISTS "attendances_select_own_or_company" ON public.attendances;
CREATE POLICY "attendances_select_own_or_company" ON public.attendances
FOR SELECT USING (
    user_id = auth.uid()
    OR company_id IN (
        SELECT u.company_id FROM public.users u
        WHERE u.id = auth.uid()
          AND u.role IN ('super_admin', 'company_admin', 'manager')
    )
);

-- Aucune politique INSERT / UPDATE / DELETE : l'écriture directe est impossible,
-- y compris pour un utilisateur authentifié. C'est volontaire.

DROP POLICY IF EXISTS "attempts_select_own_or_company" ON public.attendance_attempts;
CREATE POLICY "attempts_select_own_or_company" ON public.attendance_attempts
FOR SELECT USING (
    user_id = auth.uid()
    OR company_id IN (
        SELECT u.company_id FROM public.users u
        WHERE u.id = auth.uid()
          AND u.role IN ('super_admin', 'company_admin', 'manager')
    )
);


-- =============================================================================
-- 8. STOCKAGE DES SELFIES DE POINTAGE
--
-- Bucket PRIVÉ, contrairement aux photos de profil : un selfie de pointage est
-- une preuve horodatée, consultable uniquement par les personnes habilitées
-- via une URL signée de courte durée.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('punch-selfies', 'punch-selfies', FALSE, 1048576, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
SET public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "punch_selfies_insert_authenticated" ON storage.objects;
CREATE POLICY "punch_selfies_insert_authenticated" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'punch-selfies');

-- Lecture réservée : l'employé concerné (le chemin commence par son uid) et
-- les rôles habilités de son entreprise.
DROP POLICY IF EXISTS "punch_selfies_read_restricted" ON storage.objects;
CREATE POLICY "punch_selfies_read_restricted" ON storage.objects
FOR SELECT TO authenticated
USING (
    bucket_id = 'punch-selfies'
    AND (
        (storage.foldername(name))[1] = auth.uid()::text
        OR EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid()
              AND u.role IN ('super_admin', 'company_admin', 'manager')
        )
    )
);
