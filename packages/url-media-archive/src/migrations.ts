export const initialMigrationSql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'url_archive_status') THEN
    CREATE TYPE url_archive_status AS ENUM (
      'pending',
      'probing',
      'no_media',
      'downloading',
      'stored',
      'failed',
      'terminal_failed',
      'skipped'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'url_probe_status') THEN
    CREATE TYPE url_probe_status AS ENUM (
      'unknown',
      'has_media',
      'no_media',
      'unavailable',
      'auth_required'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS url_archive_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  url text NOT NULL,
  canonical_url text NOT NULL UNIQUE,

  status url_archive_status NOT NULL DEFAULT 'pending',
  probe_status url_probe_status NOT NULL DEFAULT 'unknown',

  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  stored_at timestamptz,

  ytdlp_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb NOT NULL DEFAULT '{}'::jsonb,

  restate_invocation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS url_archive_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES url_archive_jobs(id) ON DELETE CASCADE,

  source text NOT NULL,
  source_key text,
  source_url text NOT NULL,
  source_created_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source, source_key)
);

CREATE TABLE IF NOT EXISTS url_archive_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES url_archive_jobs(id) ON DELETE CASCADE,

  sink_type text NOT NULL DEFAULT 'filesystem',
  path text NOT NULL,
  bytes bigint,
  mime_type text,
  blake3 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (job_id, path)
);

CREATE INDEX IF NOT EXISTS url_archive_jobs_queue_idx
  ON url_archive_jobs (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS url_archive_sources_job_idx
  ON url_archive_sources (job_id);

CREATE INDEX IF NOT EXISTS url_archive_sources_source_idx
  ON url_archive_sources (source, source_key);

ALTER TABLE url_archive_outputs
  ADD COLUMN IF NOT EXISTS blake3 text;

CREATE INDEX IF NOT EXISTS url_archive_outputs_job_idx
  ON url_archive_outputs (job_id);

CREATE INDEX IF NOT EXISTS url_archive_outputs_blake3_bytes_idx
  ON url_archive_outputs (blake3, bytes)
  WHERE blake3 IS NOT NULL;
`;
