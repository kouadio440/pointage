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
    registration_number VARCHAR(50), -- Matricule
    phone_number VARCHAR(50),
    avatar_url TEXT,
    face_embedding TEXT, -- Vecteur d'empreinte faciale chiffré
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
    status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED')),
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
CREATE POLICY "Public & Anon access on companies" ON public.companies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on users" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on geofences" ON public.geofences FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on attendances" ON public.attendances FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on payrolls" ON public.payrolls FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on audit_logs" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on calendar_events" ON public.calendar_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public & Anon access on company_memberships" ON public.company_memberships FOR ALL USING (true) WITH CHECK (true);

