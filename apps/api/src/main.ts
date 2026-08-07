import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // La configuration est validee AVANT que quoi que ce soit ne demarre :
  // mieux vaut un processus qui refuse de se lancer qu'une API en ligne avec
  // une cle de chiffrement vide, decouverte au premier pointage.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, {
    logger:
      env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
  });

  app.use(
    helmet({
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      frameguard: { action: 'deny' },
      // L'API sert du JSON, pas du HTML : aucune CSP a definir ici.
      // Elle est portee par apps/app et apps/web.
      contentSecurityPolicy: false,
    }),
  );

  // CORS par LISTE BLANCHE explicite. Jamais `origin: true`, qui reflechit
  // l'origine de l'appelant et annule toute protection.
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Refresh'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      // Une cle inconnue est REJETEE, pas silencieusement retiree : retirer
      // masque les bugs du client, rejeter les revele immediatement.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Les televersements passent par des URL presignees, directement vers le
  // stockage objet : aucun fichier ne transite par l'API. 256 Ko suffisent
  // donc largement, et bornent la surface d'attaque.
  const express = await import('express');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ limit: '256kb', extended: true }));

  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  new Logger('Bootstrap').log(`API a l'ecoute sur ${env.API_URL} (${env.NODE_ENV})`);
}

void bootstrap();
