-- Migration 007: Fix Leave Table & RLS Policies for Employee Dashboard & Cockpit RH

CREATE TABLE IF NOT EXISTS public.leaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    user_email TEXT,
    employee TEXT,
    type TEXT DEFAULT 'Congé Payé Annuel',
    start_date DATE,
    end_date DATE,
    period TEXT,
    days INTEGER DEFAULT 1,
    reason TEXT,
    status TEXT DEFAULT 'En attente',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Activer RLS sur public.leaves
ALTER TABLE public.leaves ENABLE ROW LEVEL SECURITY;

-- Policies RLS permissives pour public / anon / authenticated
DROP POLICY IF EXISTS "Allow authenticated read leaves" ON public.leaves;
DROP POLICY IF EXISTS "Allow read leaves" ON public.leaves;
CREATE POLICY "Allow read leaves" ON public.leaves FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow authenticated insert leaves" ON public.leaves;
DROP POLICY IF EXISTS "Allow insert leaves" ON public.leaves;
CREATE POLICY "Allow insert leaves" ON public.leaves FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated update leaves" ON public.leaves;
DROP POLICY IF EXISTS "Allow update leaves" ON public.leaves;
CREATE POLICY "Allow update leaves" ON public.leaves FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow delete leaves" ON public.leaves;
CREATE POLICY "Allow delete leaves" ON public.leaves FOR DELETE USING (true);

-- Synchronisation de la table public.leave (singulier) si elle existe déjà
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'leave') THEN
        EXECUTE 'ALTER TABLE public.leave ENABLE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS "Allow read leave" ON public.leave';
        EXECUTE 'CREATE POLICY "Allow read leave" ON public.leave FOR SELECT USING (true)';
        EXECUTE 'DROP POLICY IF EXISTS "Allow insert leave" ON public.leave';
        EXECUTE 'CREATE POLICY "Allow insert leave" ON public.leave FOR INSERT WITH CHECK (true)';
        EXECUTE 'DROP POLICY IF EXISTS "Allow update leave" ON public.leave';
        EXECUTE 'CREATE POLICY "Allow update leave" ON public.leave FOR UPDATE USING (true)';
    END IF;
END $$;
