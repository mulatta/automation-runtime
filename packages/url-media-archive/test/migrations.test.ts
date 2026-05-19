import { initialMigrationSql } from "../src/migrations";

describe("database migrations", () => {
  it("creates generic archive tables and indexes", () => {
    expect(initialMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS url_archive_jobs",
    );
    expect(initialMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS url_archive_sources",
    );
    expect(initialMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS url_archive_outputs",
    );
    expect(initialMigrationSql).toContain("canonical_url text NOT NULL UNIQUE");
    expect(initialMigrationSql).toContain("UNIQUE (source, source_key)");
    expect(initialMigrationSql).toContain("url_archive_jobs_queue_idx");
  });
});
