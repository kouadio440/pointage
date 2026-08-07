#!/usr/bin/env node
/**
 * Genere les secrets cryptographiques du fichier .env.
 *
 *   - Paire de cles EdDSA (Ed25519) pour signer les jetons d'acces.
 *     Ed25519 plutot que RSA : signatures 64 octets, verification tres rapide,
 *     et aucun choix de taille de cle a se tromper.
 *   - Cle maitre AES-256-GCM protegeant les embeddings biometriques et les
 *     secrets QR.
 *
 * Usage :
 *   node scripts/generate-keys.mjs           # affiche les valeurs
 *   node scripts/generate-keys.mjs --write   # les ecrit dans .env
 *
 * Les secrets ne sont JAMAIS committes : .env est ignore par git.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const values = {
  JWT_PRIVATE_KEY_B64: Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64'),
  JWT_PUBLIC_KEY_B64: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
    'base64',
  ),
  ENCRYPTION_MASTER_KEY: randomBytes(32).toString('base64'),
};

if (!process.argv.includes('--write')) {
  console.log('Valeurs generees (non ecrites) :\n');
  for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  console.log('\nRelancez avec --write pour les inscrire dans .env.');
  process.exit(0);
}

let env;
try {
  env = readFileSync(ENV_PATH, 'utf8');
} catch {
  console.error(`.env introuvable. Copiez d'abord .env.example :\n  cp .env.example .env`);
  process.exit(1);
}

let replaced = 0;
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, `${key}=${value}`);
    replaced += 1;
  } else {
    env += `\n${key}=${value}`;
    replaced += 1;
  }
}

writeFileSync(ENV_PATH, env, 'utf8');
console.log(`✓ ${replaced} secrets ecrits dans .env`);
console.log('  Ces valeurs sont locales. La production utilise SSM/Doppler (voir docs/RUNBOOK.md).');
