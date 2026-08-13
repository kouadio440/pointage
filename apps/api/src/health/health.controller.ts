import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { SupabaseService } from '../common/supabase/supabase.service.js';

/**
 * Sondes de sante.
 *
 * `/health/live`  : le processus repond. Ne touche aucune dependance.
 * `/health/ready` : les dependances repondent. C'est celle que l'orchestrateur
 *                   interroge avant d'envoyer du trafic.
 *
 * Aucune information d'infrastructure n'est divulguee : un attaquant n'apprend
 * ni la version de PostgreSQL, ni la topologie, seulement « pret » ou « pas pret ».
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, boolean> }> {
    const checks: Record<string, boolean> = { database: false, supabase: false };

    try {
      checks.database = await this.prisma.ping();
    } catch {
      checks.database = false;
    }

    try {
      checks.supabase = this.supabase.isConfigured() ? await this.supabase.ping() : false;
    } catch {
      checks.supabase = false;
    }

    const allUp = Object.values(checks).every(Boolean);
    return { status: allUp ? 'ok' : 'degraded', checks };
  }
}
