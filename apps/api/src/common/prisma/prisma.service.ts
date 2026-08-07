import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTenantExtension } from './tenant-extension.js';

/**
 * Forme d'un evenement de journal Prisma.
 *
 * Declaree localement plutot qu'importee : le nom du type expose a change entre
 * versions majeures de Prisma, et une sonde de journalisation n'a pas a casser
 * la compilation lors d'une montee de version.
 */
interface PrismaLogEvent {
  timestamp: Date;
  message: string;
  target: string;
}

/**
 * Client Prisma etendu par l'isolation multi-entreprises.
 *
 * Seul le client ETENDU est expose aux services metier. Le client brut reste
 * prive : s'il etait accessible, le premier mur d'isolation deviendrait
 * contournable par simple inattention, ce qui reviendrait a ne pas l'avoir.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  private readonly base = new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  /** Le seul client utilisable par les services metier. */
  readonly db: ReturnType<PrismaService['extend']>;

  constructor() {
    this.base.$on('warn', (e: PrismaLogEvent) => this.logger.warn(e.message));
    this.base.$on('error', (e: PrismaLogEvent) => this.logger.error(e.message));
    this.db = this.extend();
  }

  private extend() {
    return this.base.$extends(createTenantExtension());
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Connexion PostgreSQL etablie.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /**
   * Sonde de disponibilite pour /health/ready.
   * Passe deliberement par le client BRUT : une sonde de sante ne doit pas
   * dependre d'un contexte tenant, qui n'existe pas sur cette route.
   */
  async ping(): Promise<boolean> {
    await this.base.$queryRaw`SELECT 1`;
    return true;
  }
}

export type ExtendedPrismaClient = PrismaService['db'];
