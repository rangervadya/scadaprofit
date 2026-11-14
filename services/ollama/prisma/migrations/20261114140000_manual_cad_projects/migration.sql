CREATE TABLE IF NOT EXISTS "manual_cad_projects" (
    "id" UUID PRIMARY KEY,
    "title" VARCHAR(200) NOT NULL,
    "data" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "manual_cad_projects_updated_at_idx" ON "manual_cad_projects"("updated_at" DESC);
CREATE INDEX IF NOT EXISTS "manual_cad_projects_source_job_id_idx" ON "manual_cad_projects" ((data->>'sourceJobId'));
CREATE INDEX IF NOT EXISTS "manual_cad_projects_source_report_id_idx" ON "manual_cad_projects" ((data->>'sourceReportId'));