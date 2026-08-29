-- =============================================================================
-- Winner Pointage — Migration 006 : declarations d'heures supplementaires
--
-- Idempotente. A executer apres les migrations precedentes.
--
-- CONTEXTE
-- --------
-- Aucune table applicative n'existait pour les heures supplementaires. La
-- fonction submitOvertimeRequest() se contentait d'empiler en memoire un objet
-- entierement code en dur (date '06/08/2026', creneau '17:00 - 19:30', duree
-- '2.5 h', motif 'Surcroit impression packaging urgent') sans jamais lire le
-- formulaire ni ecrire quoi que ce soit.
--
-- On calque la structure sur public.leaves, qui est la convention applicative
-- en service, plutot que sur la table Prisma "overtime" (camelCase, clefs
-- etrangeres vers un autre schema) : melanger les deux produirait deux verites.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.overtimes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES public.users(id) ON DELETE CASCADE,
    user_email TEXT,
    employee   TEXT,

    work_date  DATE NOT NULL,
    start_time TEXT NOT NULL,          -- 'HH:MM'
    end_time   TEXT NOT NULL,          -- 'HH:MM'
    slot       TEXT,                   -- '17:00 - 19:30', pre-calcule pour l'affichage
    minutes    INTEGER NOT NULL,       -- duree reelle, source de verite du calcul
    rate_pct   INTEGER DEFAULT 25,     -- majoration appliquee, en pourcentage

    reason TEXT,
    status TEXT DEFAULT 'En attente',

    decided_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decided_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT overtimes_minutes_positive CHECK (minutes > 0 AND minutes <= 1440),
    CONSTRAINT overtimes_status_valid CHECK (status IN ('En attente', 'Validé', 'Refusé'))
);

CREATE INDEX IF NOT EXISTS idx_overtimes_company_date
    ON public.overtimes (company_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_overtimes_user
    ON public.overtimes (company_id, user_id, work_date DESC);

ALTER TABLE public.overtimes ENABLE ROW LEVEL SECURITY;

-- Politiques alignees sur celles de public.leaves, afin que le comportement
-- soit homogene entre les deux ecrans. A durcir en meme temps que leaves
-- lorsque l'ensemble des tables applicatives sera verrouille.
DROP POLICY IF EXISTS "Allow read overtimes"   ON public.overtimes;
DROP POLICY IF EXISTS "Allow insert overtimes" ON public.overtimes;
DROP POLICY IF EXISTS "Allow update overtimes" ON public.overtimes;
DROP POLICY IF EXISTS "Allow delete overtimes" ON public.overtimes;

CREATE POLICY "Allow read overtimes"   ON public.overtimes FOR SELECT USING (true);
CREATE POLICY "Allow insert overtimes" ON public.overtimes FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update overtimes" ON public.overtimes FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete overtimes" ON public.overtimes FOR DELETE USING (true);
