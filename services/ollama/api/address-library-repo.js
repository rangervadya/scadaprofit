import { getPrismaClient, postgresEnabled } from './db.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'address-library' });

/**
 * Address library on normalized tables (P1-14).
 *
 * The JSONB singleton used to hold `{ streets: [ { id, name, createdAt,
 * buildings: [ { id, name, createdAt, schemes: [ ... ] } ] } ] }`. Rows are now
 * stored per entity so streets/buildings/schemes can be queried by key, while
 * `fetchAddressLibrary()` re-assembles the same shape the routes expect.
 */

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

export async function fetchAddressLibrary() {
  if (!postgresEnabled()) return null;
  const prisma = await getPrismaClient();
  const streets = await prisma.addressStreet.findMany({
    orderBy: { createdAt: 'asc' },
    include: { buildings: { orderBy: { createdAt: 'asc' }, include: { schemes: { orderBy: { createdAt: 'asc' } } } } },
  });
  if (!streets.length) return null;
  return {
    schemaVersion: 1,
    streets: streets.map((street) => ({
      id: street.id,
      name: street.name,
      createdAt: iso(street.createdAt),
      buildings: street.buildings.map((building) => ({
        id: building.id,
        name: building.name,
        createdAt: iso(building.createdAt),
        schemes: building.schemes.map((scheme) => ({
          id: scheme.id,
          jobId: scheme.jobId,
          title: scheme.title,
          status: scheme.status,
          sourceName: scheme.sourceName || '',
          originalName: scheme.originalName || '',
          uploadedBy: scheme.uploadedBy || '',
          error: scheme.error || '',
          createdAt: iso(scheme.createdAt),
          updatedAt: iso(scheme.updatedAt),
          completedAt: iso(scheme.completedAt),
        })),
      })),
    })),
  };
}

/**
 * Replace the whole library with `library`. Streets/buildings/schemes are keyed
 * by id, so the diff is a delete-then-insert inside one transaction: simple and
 * still O(n) in library size (which is small).
 */
export async function saveAddressLibrary(library) {
  if (!postgresEnabled()) return false;
  const prisma = await getPrismaClient();
  const streets = Array.isArray(library?.streets) ? library.streets : [];

  await prisma.$transaction(async (tx) => {
    const keepStreets = new Set();
    const keepBuildings = new Set();
    const keepSchemes = new Set();

    for (const street of streets) {
      const streetId = String(street?.id || '');
      if (!streetId) continue;
      keepStreets.add(streetId);
      await tx.addressStreet.upsert({
        where: { id: streetId },
        create: { id: streetId, name: String(street.name || '') },
        update: { name: String(street.name || '') },
      });

      const buildings = Array.isArray(street.buildings) ? street.buildings : [];
      for (const building of buildings) {
        const buildingId = String(building?.id || '');
        if (!buildingId) continue;
        keepBuildings.add(buildingId);
        await tx.addressBuilding.upsert({
          where: { id: buildingId },
          create: { id: buildingId, streetId, name: String(building.name || '') },
          update: { streetId, name: String(building.name || '') },
        });

        const schemes = Array.isArray(building.schemes) ? building.schemes : [];
        for (const scheme of schemes) {
          const jobId = String(scheme?.jobId || scheme?.id || '');
          if (!jobId) continue;
          keepSchemes.add(jobId);
          const row = {
            id: jobId,
            buildingId,
            jobId,
            title: String(scheme.title || ''),
            status: String(scheme.status || 'completed'),
            sourceName: scheme.sourceName ? String(scheme.sourceName) : null,
            originalName: scheme.originalName ? String(scheme.originalName) : null,
            uploadedBy: scheme.uploadedBy ? String(scheme.uploadedBy) : null,
            error: scheme.error ? String(scheme.error) : null,
            completedAt: scheme.completedAt ? new Date(scheme.completedAt) : null,
          };
          await tx.addressScheme.upsert({
            where: { id: jobId },
            create: row,
            update: {
              buildingId: row.buildingId,
              title: row.title,
              status: row.status,
              sourceName: row.sourceName,
              originalName: row.originalName,
              uploadedBy: row.uploadedBy,
              error: row.error,
              completedAt: row.completedAt,
            },
          });
        }
      }
    }

    // Remove entities that disappeared from the library.
    const staleSchemes = await tx.addressScheme.findMany({ select: { jobId: true } });
    const staleSchemeIds = staleSchemes.map((row) => row.jobId).filter((id) => !keepSchemes.has(id));
    if (staleSchemeIds.length) await tx.addressScheme.deleteMany({ where: { jobId: { in: staleSchemeIds } } });

    const staleBuildings = await tx.addressBuilding.findMany({ select: { id: true } });
    const staleBuildingIds = staleBuildings.map((row) => row.id).filter((id) => !keepBuildings.has(id));
    if (staleBuildingIds.length) await tx.addressBuilding.deleteMany({ where: { id: { in: staleBuildingIds } } });

    const staleStreets = await tx.addressStreet.findMany({ select: { id: true } });
    const staleStreetIds = staleStreets.map((row) => row.id).filter((id) => !keepStreets.has(id));
    if (staleStreetIds.length) await tx.addressStreet.deleteMany({ where: { id: { in: staleStreetIds } } });
  });

  log.debug({ streets: streets.length }, 'Address library saved to normalized tables');
  return true;
}
