-- =============================================================================
-- Winner Pointage — Schéma de base de données Supabase (PostgreSQL + RLS)
-- À exécuter dans l'éditeur SQL de votre projet Supabase (https://supabase.com)
-- =============================================================================

-- Extension pour UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Table des Entreprises (Clients SaaS)
CREATE TABLE IF NOT EXISTS public.companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    siret_or_rccm VARCHAR(100),
    plan VARCHAR(50) DEFAULT 'pro' CHECK (plan IN ('starter', 'pro', 'enterprise')),
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'trial', 'suspended', 'expired')),
    max_employees INT DEFAULT 50,
    company_code VARCHAR(50) UNIQUE, -- Code d'entreprise public pour auto-inscription (ex: WD-7K9P-X4M2)
    employee_prefix VARCHAR(20) DEFAULT 'EMP', -- Préfixe personnalisé du matricule (ex: EMP, WD, SOC)
    employee_counter INT DEFAULT 0, -- Compteur de matricules par entreprise
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Table des Utilisateurs & Employés (Intégré avec Supabase Auth si besoin)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'employee' CHECK (role IN ('super_admin', 'company_admin', 'manager', 'employee', 'field_agent')),
    job_title VARCHAR(100),
    registration_number VARCHAR(50), -- Matricule (ex: EMP-0001)
    phone_number VARCHAR(50),
    avatar_url TEXT,
    face_embedding TEXT, -- Vecteur d'empreinte faciale chiffré
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_company_registration_number UNIQUE(company_id, registration_number)
);

-- 3. Zones de Géofencing (Autorisations GPS par entreprise)
CREATE TABLE IF NOT EXISTS public.geofences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
    name VARCHAR(100) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    radius_meters INT DEFAULT 200,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Registre des Pointages (Attendances Anti-fraude)
CREATE TABLE IF NOT EXISTS public.attendances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    geofence_id UUID REFERENCES public.geofences(id) ON DELETE SET NULL,
    method VARCHAR(50) NOT NULL CHECK (method IN ('gps', 'qr_kiosk', 'face_id', 'manual')),
    status VARCHAR(50) NOT NULL DEFAULT 'on_time' CHECK (status IN ('on_time', 'late', 'early_leave', 'absent')),
    
    clock_in TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    clock_out TIMESTAMP WITH TIME ZONE,
    
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    gps_accuracy_meters DOUBLE PRECISION,
    is_fake_gps_detected BOOLEAN DEFAULT FALSE,
    face_confidence_score DOUBLE PRECISION,
    qr_token_used VARCHAR(255),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Calculs des Paies & Penalités
CREATE TABLE IF NOT EXISTS public.payrolls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    year INT NOT NULL CHECK (year >= 2024),
    
    total_hours_worked DOUBLE PRECISION DEFAULT 0,
    overtime_hours DOUBLE PRECISION DEFAULT 0,
    late_minutes INT DEFAULT 0,
    lateness_deductions_fcfa INT DEFAULT 0,
    overtime_bonus_fcfa INT DEFAULT 0,
    final_salary_fcfa INT DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Journal d'Audit & Alertes Sécurité (Anti-usurpation & Fake GPS)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
    description TEXT NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Échéances & Calendrier SaaS
CREATE TABLE IF NOT EXISTS public.calendar_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    day INT NOT NULL,
    time_start VARCHAR(10),
    time_end VARCHAR(10),
    title VARCHAR(255) NOT NULL,
    client VARCHAR(255),
    amount VARCHAR(100),
    type VARCHAR(50) DEFAULT 'billing',
    badge VARCHAR(100),
    color VARCHAR(50) DEFAULT 'emerald',
    status VARCHAR(50) DEFAULT 'Pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Table des Appartenances Multi-Entreprises & Invitations
CREATE TABLE IF NOT EXISTS public.company_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'EMPLOYEE' CHECK (role IN ('CEO', 'HR', 'MANAGER', 'EMPLOYEE')),
    attendance_required BOOLEAN DEFAULT TRUE,
    invitation_code VARCHAR(100) UNIQUE,
    status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, company_id)
);

-- Active le Row Level Security (RLS) sur Supabase
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_memberships ENABLE ROW LEVEL SECURITY;

-- Politiques RLS de base (Accès pour anon et service_role)
DROP POLICY IF EXISTS "Public & Anon access on companies" ON public.companies;
CREATE POLICY "Public & Anon access on companies" ON public.companies FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on users" ON public.users;
CREATE POLICY "Public & Anon access on users" ON public.users FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on geofences" ON public.geofences;
CREATE POLICY "Public & Anon access on geofences" ON public.geofences FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on attendances" ON public.attendances;
CREATE POLICY "Public & Anon access on attendances" ON public.attendances FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on payrolls" ON public.payrolls;
CREATE POLICY "Public & Anon access on payrolls" ON public.payrolls FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on audit_logs" ON public.audit_logs;
CREATE POLICY "Public & Anon access on audit_logs" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on calendar_events" ON public.calendar_events;
CREATE POLICY "Public & Anon access on calendar_events" ON public.calendar_events FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public & Anon access on company_memberships" ON public.company_memberships;
CREATE POLICY "Public & Anon access on company_memberships" ON public.company_memberships FOR ALL USING (true) WITH CHECK (true);

-- =============================================================================
-- Stockage des Photos de Profil (Supabase Storage)
--
-- IMPORTANT : un bucket de stockage ne se crée PAS avec un CREATE TABLE. Sans
-- ce bloc, tout upload vers .storage.from('avatars') échoue, l'application
-- retombe silencieusement sur une image encodée en base64, et la photo de
-- profil disparaît à la reconnexion. C'était exactement le défaut constaté.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'avatars',
    'avatars',
    TRUE,                                            -- lecture publique : une photo de profil s'affiche sans jeton
    2097152,                                         -- plafond serveur de 2 Mo, indépendant du client
    ARRAY['image/jpeg', 'image/png', 'image/webp']   -- le type est vérifié côté serveur, pas seulement dans le navigateur
)
ON CONFLICT (id) DO UPDATE
SET public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Politiques d'accès au bucket.
-- ATTENTION : elles sont aussi permissives que celles des tables ci-dessus
-- (accès anonyme), ce qui convient au développement mais PAS à la production :
-- n'importe qui peut y déposer un fichier. À restreindre à auth.uid() dès que
-- l'authentification Supabase sera obligatoire — voir docs/RUNBOOK.md.
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read" ON storage.objects
    FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
CREATE POLICY "avatars_insert" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
CREATE POLICY "avatars_update" ON storage.objects
    FOR UPDATE USING (bucket_id = 'avatars') WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_delete" ON storage.objects;
CREATE POLICY "avatars_delete" ON storage.objects
    FOR DELETE USING (bucket_id = 'avatars');

-- =============================================================================
-- Fonction SQL Atomique : Génération Sécurisée de Matricule par Entreprise
-- (Verrouillage FOR UPDATE pour garantir zéro collision lors des créations simultanées)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_next_employee_number(p_company_id UUID)
RETURNS VARCHAR(50)
LANGUAGE plpgsql
AS $$
DECLARE
    v_prefix VARCHAR(20);
    v_counter INT;
    v_next_matricule VARCHAR(50);
BEGIN
    -- Verrouillage de la ligne d'entreprise pour incrémentation atomique
    SELECT COALESCE(employee_prefix, 'EMP'), COALESCE(employee_counter, 0) + 1
    INTO v_prefix, v_counter
    FROM public.companies
    WHERE id = p_company_id
    FOR UPDATE;

    IF v_prefix IS NULL OR v_prefix = '' THEN
        v_prefix := 'EMP';
    END IF;
    
    IF v_counter IS NULL THEN
        v_counter := 1;
    END IF;

    -- Formater le matricule avec 4 chiffres (ex: EMP-0001)
    v_next_matricule := v_prefix || '-' || LPAD(v_counter::text, 4, '0');

    -- Mettre à jour le compteur dans l'entreprise
    UPDATE public.companies
    SET employee_counter = v_counter
    WHERE id = p_company_id;

    RETURN v_next_matricule;
END;
$$;
