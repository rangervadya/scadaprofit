/**
 * Load the private MOSS settings before server.js starts.
 * This makes MOSS credentials and feature flags available to every Python
 * child process launched by the app, including stored-house analysis paths
 * that currently pass only the OpenRouter-specific env object to spawn().
 * The API key is never logged or returned to the browser.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dataDir = process.env.DATA_DIR || path.join(os.tmpdir(), 'cad-reconstruction-jobs');
const settingsPath = path.join(dataDir, '.private', 'moss-ai-settings.json');

try {
  const raw = await readFile(settingsPath, 'utf8');
  const settings = JSON.parse(raw);
  const apiKey = String(settings?.apiKey || '').trim();
  const enabled = Boolean(apiKey) && settings?.enabled === true;

  process.env.MOSS_API_KEY = enabled ? apiKey : '';
  process.env.MOSS_MODEL = 'moss-vl-1.0';
  process.env.MOSS_OCR_ENABLED = enabled && settings?.ocrEnabled !== false ? '1' : '0';
  process.env.MOSS_PIPE_ENABLED = enabled && settings?.pipeEnabled !== false ? '1' : '0';

  console.info(
    `[AI] MOSS startup settings loaded: enabled=${enabled}, ` +
    `OCR=${process.env.MOSS_OCR_ENABLED}, PIPE=${process.env.MOSS_PIPE_ENABLED}`
  );
} catch (error) {
  // Preserve any explicitly supplied environment configuration when no
  // private settings file exists. The key itself is never printed.
  if (error?.code !== 'ENOENT') {
    console.error('[AI] Cannot load private MOSS startup settings:', error?.message || error);
  }
}
