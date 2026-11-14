CREATE TABLE IF NOT EXISTS "address_library" (
    "id" INTEGER PRIMARY KEY,
    "schema_version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "address_library_singleton" CHECK ("id" = 1)
);