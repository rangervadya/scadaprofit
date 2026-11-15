import express from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Address library routes (P2-1): streets and buildings.
 *
 * The scheme routes live in library-schemes-routes.js; they depend on the
 * analysis queue and are extracted separately.
 */
export function createLibraryRouter({
  readAddressLibrary,
  updateAddressLibrary,
  validateBody,
  streetSchema,
  buildingSchema,
  cleanLabel,
  sendJsonConditional,
  UUID_PATTERN,
}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const library = await readAddressLibrary();
      return sendJsonConditional(req, res, { ok: true, library });
    } catch (error) {
      req.log.error({ err: error }, 'Cannot read address library');
      return res.status(500).json({ error: 'Не удалось прочитать папки объектов.' });
    }
  });

  router.post('/streets', validateBody(streetSchema), async (req, res) => {
    const name = cleanLabel(req.body?.name, 100);
    if (!name) return res.status(400).json({ error: 'Укажи название улицы.' });
    try {
      const street = await updateAddressLibrary((library) => {
        if (library.streets.some((item) => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
          const error = new Error('Такая улица уже есть в папках.');
          error.status = 409;
          throw error;
        }
        const created = { id: randomUUID(), name, createdAt: new Date().toISOString(), buildings: [] };
        library.streets.push(created);
        return created;
      });
      return res.status(201).json({ ok: true, street });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'Не удалось создать улицу.' });
    }
  });

  router.post('/buildings', validateBody(buildingSchema), async (req, res) => {
    const streetId = String(req.body?.streetId || '');
    const name = cleanLabel(req.body?.name, 80);
    if (!UUID_PATTERN.test(streetId) || !name)
      return res.status(400).json({ error: 'Выбери улицу и укажи номер дома.' });
    try {
      const building = await updateAddressLibrary((library) => {
        const street = library.streets.find((item) => item.id === streetId);
        if (!street) {
          const error = new Error('Улица не найдена. Обнови список папок.');
          error.status = 404;
          throw error;
        }
        if (street.buildings.some((item) => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
          const error = new Error('Такой дом уже есть в этой улице.');
          error.status = 409;
          throw error;
        }
        const created = { id: randomUUID(), name, createdAt: new Date().toISOString(), schemes: [] };
        street.buildings.push(created);
        return created;
      });
      return res.status(201).json({ ok: true, building });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'Не удалось создать дом.' });
    }
  });

  return router;
}
