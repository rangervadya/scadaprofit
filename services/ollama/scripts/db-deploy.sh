#!/bin/sh
# Apply the Prisma schema to PostgreSQL.
#
# `migrate deploy` is preferred: it records which migrations ran and executes
# any data backfill they contain. It refuses a schema that already has tables
# but no migration history (P3005), which happens whenever something else
# created tables first — vdgo-backend does exactly that on startup.
#
# In that case fall back to `db push`. It is additive: every table the Prisma
# schema knows about is created or altered, nothing is dropped. Tables owned by
# other services are safe only because they are declared in schema.prisma
# (ArchiveEntry) — keep that true when adding tables elsewhere.
set -e

SCHEMA="${SCHEMA:-prisma/schema.prisma}"

if npx prisma migrate deploy --schema "$SCHEMA"; then
  exit 0
fi

echo "db-deploy: migrate deploy refused (P3005: schema exists without migration history)" >&2
echo "db-deploy: falling back to 'prisma db push' (additive, no data loss)" >&2
# --skip-generate: the client is generated at image build time, and the app
# container runs with a read-only rootfs, so writing node_modules/.prisma here
# fails with EROFS.
exec npx prisma db push --schema "$SCHEMA" --skip-generate