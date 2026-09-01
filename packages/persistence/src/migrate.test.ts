import { describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations, type Migration } from "./migrate";

const migrations: readonly Migration[] = [
  {
    name: "0001_learning_memory.sql",
    sql: "CREATE TABLE learner_profiles(id text)",
    checksum: "one",
  },
  {
    name: "0002_gateway_durable_events.sql",
    sql: "CREATE TABLE gateway_durable_events(id text)",
    checksum: "two",
  },
  {
    name: "0004_session_mutation_effects.sql",
    sql: "CREATE TABLE session_mutation_effects(id text)",
    checksum: "four",
  },
  {
    name: "0005_learning_context_retention_indexes.sql",
    sql: "CREATE INDEX concept_mastery_learner_updated_idx ON concept_mastery(learner_id)",
    checksum: "five",
  },
];

describe("applyMigrations", () => {
  it("loads the complete ordered migration history", async () => {
    await expect(loadMigrations()).resolves.toEqual([
      expect.objectContaining({ name: "0001_learning_memory.sql" }),
      expect.objectContaining({ name: "0002_gateway_durable_events.sql" }),
      expect.objectContaining({ name: "0004_session_mutation_effects.sql" }),
      expect.objectContaining({ name: "0005_learning_context_retention_indexes.sql" }),
    ]);
  });

  it("adopts only migrations whose complete canonical relation contract matches", async () => {
    const applied = new Map<string, string>();
    const executed: string[] = [];
    const comparedRelations: string[][] = [];
    const client = {
      query: vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
        executed.push(sql);
        if (sql.startsWith("WITH requested")) {
          comparedRelations.push([...(parameters[0] as string[])]);
          return { rows: [{ complete: true }] };
        }
        if (sql.startsWith("SELECT checksum")) {
          const checksum = applied.get(String(parameters[0]));
          return { rows: checksum ? [{ checksum }] : [] };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          applied.set(String(parameters[0]), String(parameters[1]));
        }
        return { rows: [] };
      }),
    };

    await applyMigrations(client, migrations);
    await applyMigrations(client, migrations);

    expect(executed.filter((sql) => sql === migrations[0]!.sql)).toHaveLength(0);
    expect(executed.filter((sql) => sql === migrations[1]!.sql)).toHaveLength(0);
    expect(executed.filter((sql) => sql === migrations[2]!.sql)).toHaveLength(0);
    expect(executed.filter((sql) => sql === migrations[3]!.sql)).toHaveLength(0);
    expect(comparedRelations[0]).toEqual([
      "learner_profiles",
      "concept_mastery",
      "misconceptions",
      "learner_preferences",
      "topic_interests",
      "session_summaries",
      "exploration_edges",
      "card_interactions",
      "visual_metadata",
      "operational_metrics",
    ]);
    expect(comparedRelations[1]).toEqual(["gateway_durable_events"]);
    expect(comparedRelations[2]).toEqual(["session_mutation_effects"]);
    expect(comparedRelations[3]).toEqual([
      "concept_mastery",
      "misconceptions",
      "topic_interests",
      "card_interactions",
      "visual_metadata",
    ]);
    expect(applied).toEqual(new Map([
      ["0001_learning_memory.sql", "one"],
      ["0002_gateway_durable_events.sql", "two"],
      ["0004_session_mutation_effects.sql", "four"],
      ["0005_learning_context_retention_indexes.sql", "five"],
    ]));
  });

  it("rolls back a failed migration without recording it", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("WITH requested")) return { rows: [{ complete: false }] };
        if (sql.startsWith("SELECT checksum")) return { rows: [] };
        if (sql === migrations[0]!.sql) throw new Error("failed");
        return { rows: [] };
      }),
    };
    await expect(applyMigrations(client, migrations)).rejects.toThrow("failed");
    expect(client.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(2);
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).startsWith("INSERT INTO schema_migrations")
    )).toBe(false);
  });

  it("rejects an existing migration ledger entry when the live schema has drifted", async () => {
    const client = {
      query: vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
        if (sql.startsWith("WITH requested")) return { rows: [{ complete: false }] };
        if (sql.startsWith("SELECT checksum") && parameters[0] === migrations[0]!.name) {
          return { rows: [{ checksum: migrations[0]!.checksum }] };
        }
        return { rows: [] };
      }),
    };

    await expect(applyMigrations(client, migrations)).rejects.toThrow(
      "does not match its complete schema contract",
    );
    expect(client.query).not.toHaveBeenCalledWith(migrations[0]!.sql);
  });

  it("validates an applied 0004 checkpoint, applies pending 0005, then accepts the upgraded schema", async () => {
    const applied = new Map(migrations.slice(0, 3).map((migration) => [
      migration.name,
      migration.checksum,
    ]));
    const executed: string[] = [];
    let contractCheck = 0;
    const client = {
      query: vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
        executed.push(sql);
        if (sql.startsWith("WITH requested")) {
          const complete = contractCheck !== 3;
          contractCheck += 1;
          return { rows: [{ complete }] };
        }
        if (sql.startsWith("SELECT checksum")) {
          const checksum = applied.get(String(parameters[0]));
          return { rows: checksum ? [{ checksum }] : [] };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          applied.set(String(parameters[0]), String(parameters[1]));
        }
        return { rows: [] };
      }),
    };

    await applyMigrations(client, migrations);
    await applyMigrations(client, migrations);

    expect(executed.filter((sql) => sql === migrations[3]!.sql)).toHaveLength(1);
    expect(applied.get(migrations[3]!.name)).toBe(migrations[3]!.checksum);
  });
});
