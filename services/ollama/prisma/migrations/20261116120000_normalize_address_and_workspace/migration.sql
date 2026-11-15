-- Normalized address library and workforce workspace (P1-14).
--
-- Expand step: create the normalized tables next to the JSONB singletons. The
-- backfill runs in this migration, so the tables are usable immediately.

CREATE TABLE IF NOT EXISTS "address_streets" (
    "id" UUID PRIMARY KEY,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "address_streets_name_idx" ON "address_streets"("name");

CREATE TABLE IF NOT EXISTS "address_buildings" (
    "id" UUID PRIMARY KEY,
    "street_id" UUID NOT NULL REFERENCES "address_streets"("id") ON DELETE CASCADE,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "address_buildings_street_id_name_key" UNIQUE ("street_id", "name")
);
CREATE INDEX IF NOT EXISTS "address_buildings_street_id_idx" ON "address_buildings"("street_id");

CREATE TABLE IF NOT EXISTS "address_schemes" (
    "id" UUID PRIMARY KEY,
    "building_id" UUID NOT NULL REFERENCES "address_buildings"("id") ON DELETE CASCADE,
    "job_id" UUID NOT NULL UNIQUE,
    "title" VARCHAR(400) NOT NULL DEFAULT '',
    "status" VARCHAR(32) NOT NULL DEFAULT 'completed',
    "source_name" VARCHAR(400),
    "original_name" VARCHAR(400),
    "uploaded_by" VARCHAR(200),
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "address_schemes_building_id_idx" ON "address_schemes"("building_id");
CREATE INDEX IF NOT EXISTS "address_schemes_status_idx" ON "address_schemes"("status");

CREATE TABLE IF NOT EXISTS "workforce_tasks" (
    "id" UUID PRIMARY KEY,
    "title" VARCHAR(400) NOT NULL DEFAULT '',
    "status" VARCHAR(32) NOT NULL DEFAULT 'assigned',
    "street" VARCHAR(300) NOT NULL DEFAULT '',
    "address" VARCHAR(100) NOT NULL DEFAULT '',
    "scheduled_date" VARCHAR(32),
    "assigned_to" UUID,
    "assigned_name" VARCHAR(200),
    "assignment_group_id" UUID,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workforce_tasks_status_idx" ON "workforce_tasks"("status");
CREATE INDEX IF NOT EXISTS "workforce_tasks_assigned_to_idx" ON "workforce_tasks"("assigned_to");
CREATE INDEX IF NOT EXISTS "workforce_tasks_scheduled_date_idx" ON "workforce_tasks"("scheduled_date");
CREATE INDEX IF NOT EXISTS "workforce_tasks_updated_at_idx" ON "workforce_tasks"("updated_at");

CREATE TABLE IF NOT EXISTS "workforce_reports" (
    "id" UUID PRIMARY KEY,
    "task_id" UUID,
    "user_id" UUID,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending_review',
    "scheme_job_id" UUID,
    "data" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workforce_reports_status_idx" ON "workforce_reports"("status");
CREATE INDEX IF NOT EXISTS "workforce_reports_task_id_idx" ON "workforce_reports"("task_id");
CREATE INDEX IF NOT EXISTS "workforce_reports_user_id_idx" ON "workforce_reports"("user_id");
CREATE INDEX IF NOT EXISTS "workforce_reports_submitted_at_idx" ON "workforce_reports"("submitted_at");

CREATE TABLE IF NOT EXISTS "workforce_defect_reports" (
    "id" UUID PRIMARY KEY,
    "task_id" UUID,
    "user_id" UUID,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending_review',
    "data" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "workforce_defect_reports_status_idx" ON "workforce_defect_reports"("status");
CREATE INDEX IF NOT EXISTS "workforce_defect_reports_task_id_idx" ON "workforce_defect_reports"("task_id");
CREATE INDEX IF NOT EXISTS "workforce_defect_reports_user_id_idx" ON "workforce_defect_reports"("user_id");
CREATE INDEX IF NOT EXISTS "workforce_defect_reports_submitted_at_idx" ON "workforce_defect_reports"("submitted_at");

-- Backfill address library from the JSONB singleton.
INSERT INTO "address_streets" ("id", "name", "created_at", "updated_at")
SELECT
    (street->>'id')::uuid,
    COALESCE(street->>'name', ''),
    COALESCE((street->>'createdAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((street->>'createdAt')::timestamptz, CURRENT_TIMESTAMP)
FROM "address_library", jsonb_array_elements(COALESCE(data->'streets', '[]'::jsonb)) AS street
WHERE data IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "address_buildings" ("id", "street_id", "name", "created_at", "updated_at")
SELECT
    (building->>'id')::uuid,
    (street->>'id')::uuid,
    COALESCE(building->>'name', ''),
    COALESCE((building->>'createdAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((building->>'createdAt')::timestamptz, CURRENT_TIMESTAMP)
FROM "address_library",
     jsonb_array_elements(COALESCE(data->'streets', '[]'::jsonb)) AS street,
     jsonb_array_elements(COALESCE(street->'buildings', '[]'::jsonb)) AS building
WHERE data IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "address_schemes" (
    "id", "building_id", "job_id", "title", "status", "source_name",
    "original_name", "uploaded_by", "error", "created_at", "updated_at", "completed_at"
)
SELECT
    (scheme->>'jobId')::uuid,
    (building->>'id')::uuid,
    (scheme->>'jobId')::uuid,
    COALESCE(scheme->>'title', ''),
    COALESCE(scheme->>'status', 'completed'),
    scheme->>'sourceName',
    scheme->>'originalName',
    scheme->>'uploadedBy',
    scheme->>'error',
    COALESCE((scheme->>'createdAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((scheme->>'updatedAt')::timestamptz, CURRENT_TIMESTAMP),
    (CASE WHEN scheme->>'completedAt' IS NULL THEN NULL ELSE (scheme->>'completedAt')::timestamptz END)
FROM "address_library",
     jsonb_array_elements(COALESCE(data->'streets', '[]'::jsonb)) AS street,
     jsonb_array_elements(COALESCE(street->'buildings', '[]'::jsonb)) AS building,
     jsonb_array_elements(COALESCE(building->'schemes', '[]'::jsonb)) AS scheme
WHERE data IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Backfill workforce workspace from the JSONB singleton.
INSERT INTO "workforce_tasks" (
    "id", "title", "status", "street", "address", "scheduled_date",
    "assigned_to", "assigned_name", "assignment_group_id", "data", "created_at", "updated_at"
)
SELECT
    (task->>'id')::uuid,
    COALESCE(task->>'title', ''),
    COALESCE(task->>'status', 'assigned'),
    COALESCE(task->>'street', ''),
    COALESCE(task->>'address', ''),
    task->>'scheduledDate',
    (CASE WHEN task->>'assignedTo' IS NULL THEN NULL ELSE (task->>'assignedTo')::uuid END),
    task->>'assignedName',
    (CASE WHEN task->>'assignmentGroupId' IS NULL THEN NULL ELSE (task->>'assignmentGroupId')::uuid END),
    task,
    COALESCE((task->>'createdAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((task->>'updatedAt')::timestamptz, CURRENT_TIMESTAMP)
FROM "workforce_workspace", jsonb_array_elements(COALESCE(data->'tasks', '[]'::jsonb)) AS task
WHERE data IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
    "title" = EXCLUDED."title",
    "status" = EXCLUDED."status",
    "street" = EXCLUDED."street",
    "address" = EXCLUDED."address",
    "scheduled_date" = EXCLUDED."scheduled_date",
    "assigned_to" = EXCLUDED."assigned_to",
    "assigned_name" = EXCLUDED."assigned_name",
    "assignment_group_id" = EXCLUDED."assignment_group_id",
    "data" = EXCLUDED."data",
    "updated_at" = EXCLUDED."updated_at";

INSERT INTO "workforce_reports" (
    "id", "task_id", "user_id", "status", "scheme_job_id", "data",
    "submitted_at", "reviewed_at", "created_at", "updated_at"
)
SELECT
    (report->>'id')::uuid,
    (CASE WHEN report->>'taskId' IS NULL THEN NULL ELSE (report->>'taskId')::uuid END),
    (CASE WHEN report->>'userId' IS NULL THEN NULL ELSE (report->>'userId')::uuid END),
    COALESCE(report->>'status', 'pending_review'),
    (CASE WHEN report->>'schemeJobId' IS NULL THEN NULL ELSE (report->>'schemeJobId')::uuid END),
    report,
    (CASE WHEN report->>'submittedAt' IS NULL THEN NULL ELSE (report->>'submittedAt')::timestamptz END),
    (CASE WHEN report->>'reviewedAt' IS NULL THEN NULL ELSE (report->>'reviewedAt')::timestamptz END),
    COALESCE((report->>'submittedAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((report->>'reviewedAt')::timestamptz, (report->>'submittedAt')::timestamptz, CURRENT_TIMESTAMP)
FROM "workforce_workspace", jsonb_array_elements(COALESCE(data->'reports', '[]'::jsonb)) AS report
WHERE data IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
    "task_id" = EXCLUDED."task_id",
    "user_id" = EXCLUDED."user_id",
    "status" = EXCLUDED."status",
    "scheme_job_id" = EXCLUDED."scheme_job_id",
    "data" = EXCLUDED."data",
    "submitted_at" = EXCLUDED."submitted_at",
    "reviewed_at" = EXCLUDED."reviewed_at",
    "updated_at" = EXCLUDED."updated_at";

INSERT INTO "workforce_defect_reports" (
    "id", "task_id", "user_id", "status", "data",
    "submitted_at", "reviewed_at", "created_at", "updated_at"
)
SELECT
    (report->>'id')::uuid,
    (CASE WHEN report->>'taskId' IS NULL THEN NULL ELSE (report->>'taskId')::uuid END),
    (CASE WHEN report->>'userId' IS NULL THEN NULL ELSE (report->>'userId')::uuid END),
    COALESCE(report->>'status', 'pending_review'),
    report,
    (CASE WHEN report->>'submittedAt' IS NULL THEN NULL ELSE (report->>'submittedAt')::timestamptz END),
    (CASE WHEN report->>'reviewedAt' IS NULL THEN NULL ELSE (report->>'reviewedAt')::timestamptz END),
    COALESCE((report->>'submittedAt')::timestamptz, CURRENT_TIMESTAMP),
    COALESCE((report->>'reviewedAt')::timestamptz, (report->>'submittedAt')::timestamptz, CURRENT_TIMESTAMP)
FROM "workforce_workspace", jsonb_array_elements(COALESCE(data->'defectReports', '[]'::jsonb)) AS report
WHERE data IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
    "task_id" = EXCLUDED."task_id",
    "user_id" = EXCLUDED."user_id",
    "status" = EXCLUDED."status",
    "data" = EXCLUDED."data",
    "submitted_at" = EXCLUDED."submitted_at",
    "reviewed_at" = EXCLUDED."reviewed_at",
    "updated_at" = EXCLUDED."updated_at";
