import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { logger } from './logger.js';

const log = logger.child({ module: 'template-store' });

export const templateExtensions = new Set(['.pdf', '.svg', '.dxf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);

export const templateMimeTypes = {
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.dxf': 'application/dxf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/**
 * Reference template store (P2-1): one global style reference, separate from
 * house uploads and analysis jobs. Files live under DATA/.private/template
 * inside the persistent cad_jobs volume; metadata is a single JSON file.
 */
export function createTemplateStore({ libraryDir, cleanLabel, limits = {} }) {
  const templateDir = path.join(libraryDir, 'template');
  const metaPath = path.join(templateDir, 'template.json');

  async function readMeta() {
    try {
      const raw = await readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      const storageName = path.basename(String(meta.storageName || ''));
      if (!storageName || !/^template-[a-f0-9-]+\.[a-z0-9]+$/i.test(storageName)) return null;
      return {
        originalName: String(meta.originalName || 'Эталонный шаблон'),
        storageName,
        mimeType:
          meta.mimeType || templateMimeTypes[path.extname(storageName).toLowerCase()] || 'application/octet-stream',
        size: Math.max(0, Number(meta.size) || 0),
        uploadedAt: meta.uploadedAt || null,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function saveMeta(meta) {
    const temporary = `${metaPath}.tmp-${randomUUID()}`;
    await mkdir(templateDir, { recursive: true });
    await writeFile(temporary, JSON.stringify(meta, null, 2), 'utf8');
    await rename(temporary, metaPath);
  }

  async function remove() {
    const meta = await readMeta();
    if (meta?.storageName) await rm(path.join(templateDir, meta.storageName), { force: true });
    await rm(metaPath, { force: true });
  }

  /** Public shape served to the client (no internal paths). */
  function toPublic(meta) {
    if (!meta) return null;
    return {
      originalName: meta.originalName || '',
      size: Number(meta.size) || 0,
      uploadedAt: meta.uploadedAt || null,
    };
  }

  /**
   * Persist an uploaded file as the active template, removing the previous one.
   * `sourcePath` is the multer temp file; `originalName` comes from the upload.
   */
  async function replaceTemplate({ sourcePath, originalName, size }) {
    const ext = path.extname(String(originalName || '')).toLowerCase();
    const safeName = cleanLabel(path.basename(String(originalName || '').replace(/\\/g, '/')), 180) || `template${ext}`;
    const storageName = `template-${randomUUID()}${ext}`;
    const destination = path.join(templateDir, storageName);
    const previous = await readMeta().catch(() => null);

    try {
      // /tmp and the named Docker volume can be different filesystems: copy, then remove.
      await copyFile(sourcePath, destination);
      const meta = {
        originalName: safeName,
        storageName,
        mimeType: templateMimeTypes[ext] || 'application/octet-stream',
        size: Number(size) || 0,
        uploadedAt: new Date().toISOString(),
      };
      await saveMeta(meta);
      if (previous?.storageName && previous.storageName !== storageName) {
        await rm(path.join(templateDir, previous.storageName), { force: true }).catch(() => {});
      }
      return meta;
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function filePath() {
    const meta = await readMeta();
    if (!meta) return null;
    return { meta, absolute: path.join(templateDir, meta.storageName) };
  }

  /** Absolute path of a stored template file, for pinning into a job folder. */
  function absolutePath(storageName) {
    return path.join(templateDir, storageName);
  }

  async function ensureDir() {
    await mkdir(templateDir, { recursive: true, mode: 0o700 });
  }

  log.debug({ templateDir }, 'Template store ready');

  return {
    ensureDir,
    readMeta,
    saveMeta,
    remove,
    toPublic,
    replaceTemplate,
    filePath,
    absolutePath,
    templateDir,
    limits,
  };
}
