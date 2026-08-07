import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { loadEnv } from './config/env.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Un seul .env, a la racine du monorepo : dupliquer les secrets par
      // application est le meilleur moyen de les voir diverger, puis fuiter.
      envFilePath: ['../../.env'],
      // La validation echoue au demarrage plutot qu'au premier appel.
      validate: loadEnv,
      cache: true,
    }),

    // Limitation de debit globale. Les seuils fins (auth 10/min, pointage
    // 20/min/employe) sont poses par route en phase 1, avec un stockage Redis
    // pour qu'ils tiennent sur plusieurs instances.
    ThrottlerModule.forRoot([{ name: 'global', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [HealthController],
  providers: [PrismaService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
