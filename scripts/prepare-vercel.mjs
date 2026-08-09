import { cp, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDist = resolve(__dirname, '..', 'apps', 'app', 'dist');
const webAppTarget = resolve(__dirname, '..', 'apps', 'web', 'app');

async function prepareVercel() {
  try {
    await mkdir(webAppTarget, { recursive: true });
    await cp(appDist, webAppTarget, { recursive: true });
    console.log(`[Vercel Prepare] Successfully copied ${appDist} -> ${webAppTarget}`);
  } catch (error) {
    console.error('[Vercel Prepare] Failed to copy app dist to web/app:', error);
    process.exit(1);
  }
}

prepareVercel();
