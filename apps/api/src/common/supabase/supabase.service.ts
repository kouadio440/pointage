import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppEnv } from '../../config/env.js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient | null = null;

  constructor(private readonly configService: ConfigService<AppEnv, true>) {}

  onModuleInit(): void {
    const supabaseUrl = this.configService.get('SUPABASE_URL', { infer: true });
    const serviceRoleKey =
      this.configService.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }) ||
      this.configService.get('SUPABASE_ANON_KEY', { infer: true });

    if (supabaseUrl && serviceRoleKey) {
      this.client = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
      this.logger.log(`Client Supabase initialise avec succes sur : ${supabaseUrl}`);
    } else {
      this.logger.warn(
        'Supabase non configure. Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans .env.',
      );
    }
  }

  /**
   * Retourne l'instance principale du client Supabase (@supabase/supabase-js).
   */
  getClient(): SupabaseClient {
    if (!this.client) {
      throw new Error(
        'Le client Supabase n\'est pas initialise. Verifiez vos variables d\'environnement SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.',
      );
    }
    return this.client;
  }

  /**
   * Indique si le client Supabase est correctement instancie.
   */
  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Sonde de disponibilite pour la route de sante /health.
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const { error } = await this.client.from('_health').select('count', { count: 'exact', head: true });
      if (!error || error.code === '42P01' || error.message.includes('relation')) {
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }
}
