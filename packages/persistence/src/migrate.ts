import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";

interface MigrationClient {
  query(text: string, parameters?: readonly unknown[]): Promise<{ rows?: Array<Record<string, unknown>> }>;
}

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const migrationUrls = [
  new URL("../../../database/migrations/0001_learning_memory.sql", import.meta.url),
  new URL("../../../database/migrations/0002_gateway_durable_events.sql", import.meta.url),
  new URL("../../../database/migrations/0004_session_mutation_effects.sql", import.meta.url),
  new URL("../../../database/migrations/0005_learning_context_retention_indexes.sql", import.meta.url),
];

const migrationRelations: Readonly<Record<string, readonly string[]>> = {
  "0001_learning_memory.sql": [
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
  ],
  "0002_gateway_durable_events.sql": ["gateway_durable_events"],
  "0004_session_mutation_effects.sql": ["session_mutation_effects"],
  "0005_learning_context_retention_indexes.sql": [
    "concept_mastery",
    "misconceptions",
    "topic_interests",
    "card_interactions",
    "visual_metadata",
  ],
};

const relationContractQuery = `WITH requested(name) AS (
  SELECT unnest($1::text[])
), signatures AS (
  SELECT
    requested.name,
    namespace.nspname,
    jsonb_build_object(
      'relation', jsonb_build_array(
        relation.relkind,
        relation.relpersistence,
        relation.relrowsecurity,
        relation.relforcerowsecurity
      ),
      'columns', (
        SELECT jsonb_agg(jsonb_build_array(
          attribute.attnum,
          attribute.attname,
          format_type(attribute.atttypid, attribute.atttypmod),
          attribute.attnotnull,
          attribute.attidentity,
          attribute.attgenerated,
          pg_get_expr(default_value.adbin, default_value.adrelid)
        ) ORDER BY attribute.attnum)
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND (
            namespace.nspname = $2
            OR EXISTS (
              SELECT 1
              FROM pg_namespace AS canonical_namespace
              JOIN pg_class AS canonical_relation
                ON canonical_relation.relnamespace = canonical_namespace.oid
               AND canonical_relation.relname = requested.name
              JOIN pg_attribute AS canonical_attribute
                ON canonical_attribute.attrelid = canonical_relation.oid
               AND canonical_attribute.attname = attribute.attname
               AND canonical_attribute.attnum > 0
               AND NOT canonical_attribute.attisdropped
              WHERE canonical_namespace.nspname = $2
            )
          )
      ),
      'constraints', (
        SELECT jsonb_agg(jsonb_build_array(
          constraint_value.conname,
          constraint_value.contype,
          constraint_value.condeferrable,
          constraint_value.condeferred,
          constraint_value.convalidated,
          replace(
            replace(
              replace(
                replace(pg_get_constraintdef(constraint_value.oid, true), format('%I.', $2::text), ''),
                $2::text || '.',
                ''
              ),
              'public.',
              ''
            ),
            '"public".',
            ''
          )
        ) ORDER BY constraint_value.conname)
        FROM pg_constraint AS constraint_value
        WHERE constraint_value.conrelid = relation.oid
          AND (
            namespace.nspname = $2
            OR EXISTS (
              SELECT 1
              FROM pg_namespace AS canonical_namespace
              JOIN pg_class AS canonical_relation
                ON canonical_relation.relnamespace = canonical_namespace.oid
               AND canonical_relation.relname = requested.name
              JOIN pg_constraint AS canonical_constraint
                ON canonical_constraint.conrelid = canonical_relation.oid
               AND canonical_constraint.conname = constraint_value.conname
              WHERE canonical_namespace.nspname = $2
            )
          )
      ),
      'indexes', (
        SELECT jsonb_agg(jsonb_build_array(
          index_relation.relname,
          index_value.indisunique,
          index_value.indisprimary,
          index_value.indisvalid,
          replace(
            replace(
              replace(
                replace(pg_get_indexdef(index_value.indexrelid), format('%I.', $2::text), ''),
                $2::text || '.',
                ''
              ),
              'public.',
              ''
            ),
            '"public".',
            ''
          )
        ) ORDER BY index_relation.relname)
        FROM pg_index AS index_value
        JOIN pg_class AS index_relation ON index_relation.oid = index_value.indexrelid
        WHERE index_value.indrelid = relation.oid
          AND (
            namespace.nspname = $2
            OR EXISTS (
              SELECT 1
              FROM pg_namespace AS canonical_namespace
              JOIN pg_class AS canonical_relation
                ON canonical_relation.relnamespace = canonical_namespace.oid
               AND canonical_relation.relname = requested.name
              JOIN pg_index AS canonical_index
                ON canonical_index.indrelid = canonical_relation.oid
              JOIN pg_class AS canonical_index_relation
                ON canonical_index_relation.oid = canonical_index.indexrelid
               AND canonical_index_relation.relname = index_relation.relname
              WHERE canonical_namespace.nspname = $2
            )
          )
      ),
      'triggers', (
        SELECT jsonb_agg(jsonb_build_array(
          trigger_value.tgname,
          trigger_value.tgenabled,
          replace(
            replace(
              replace(
                replace(pg_get_triggerdef(trigger_value.oid, true), format('%I.', $2::text), ''),
                $2::text || '.',
                ''
              ),
              'public.',
              ''
            ),
            '"public".',
            ''
          )
        ) ORDER BY trigger_value.tgname)
        FROM pg_trigger AS trigger_value
        WHERE trigger_value.tgrelid = relation.oid
          AND NOT trigger_value.tgisinternal
          AND (
            namespace.nspname = $2
            OR EXISTS (
              SELECT 1
              FROM pg_namespace AS canonical_namespace
              JOIN pg_class AS canonical_relation
                ON canonical_relation.relnamespace = canonical_namespace.oid
               AND canonical_relation.relname = requested.name
              JOIN pg_trigger AS canonical_trigger
                ON canonical_trigger.tgrelid = canonical_relation.oid
               AND canonical_trigger.tgname = trigger_value.tgname
               AND NOT canonical_trigger.tgisinternal
              WHERE canonical_namespace.nspname = $2
            )
          )
      ),
      'policies', (
        SELECT jsonb_agg(jsonb_build_array(
          policy_value.polname,
          policy_value.polcmd,
          policy_value.polpermissive,
          policy_value.polroles,
          pg_get_expr(policy_value.polqual, policy_value.polrelid),
          pg_get_expr(policy_value.polwithcheck, policy_value.polrelid)
        ) ORDER BY policy_value.polname)
        FROM pg_policy AS policy_value
        WHERE policy_value.polrelid = relation.oid
          AND (
            namespace.nspname = $2
            OR EXISTS (
              SELECT 1
              FROM pg_namespace AS canonical_namespace
              JOIN pg_class AS canonical_relation
                ON canonical_relation.relnamespace = canonical_namespace.oid
               AND canonical_relation.relname = requested.name
              JOIN pg_policy AS canonical_policy
                ON canonical_policy.polrelid = canonical_relation.oid
               AND canonical_policy.polname = policy_value.polname
              WHERE canonical_namespace.nspname = $2
            )
          )
      )
    ) AS signature
  FROM requested
  CROSS JOIN (VALUES ('public'::text), ($2::text)) AS namespace_names(nspname)
  LEFT JOIN pg_namespace AS namespace ON namespace.nspname = namespace_names.nspname
  LEFT JOIN pg_class AS relation
    ON relation.relnamespace = namespace.oid
   AND relation.relname = requested.name
   AND relation.relkind IN ('r', 'p')
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM requested
    LEFT JOIN signatures AS actual
      ON actual.name = requested.name
     AND actual.nspname = 'public'
    LEFT JOIN signatures AS canonical
      ON canonical.name = requested.name
     AND canonical.nspname = $2
    WHERE actual.signature IS NULL
       OR canonical.signature IS NULL
       OR actual.signature IS DISTINCT FROM canonical.signature
  )
  AND NOT EXISTS (
    SELECT 1
    FROM requested
    JOIN pg_namespace AS public_namespace ON public_namespace.nspname = 'public'
    JOIN pg_class AS public_relation
      ON public_relation.relnamespace = public_namespace.oid
     AND public_relation.relname = requested.name
    JOIN pg_attribute AS public_attribute
      ON public_attribute.attrelid = public_relation.oid
     AND public_attribute.attnum > 0
     AND NOT public_attribute.attisdropped
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_namespace AS final_namespace
      JOIN pg_class AS final_relation
        ON final_relation.relnamespace = final_namespace.oid
       AND final_relation.relname = requested.name
      JOIN pg_attribute AS final_attribute
        ON final_attribute.attrelid = final_relation.oid
       AND final_attribute.attname = public_attribute.attname
       AND final_attribute.attnum > 0
       AND NOT final_attribute.attisdropped
      WHERE final_namespace.nspname = $3
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM requested
    JOIN pg_namespace AS public_namespace ON public_namespace.nspname = 'public'
    JOIN pg_class AS public_relation
      ON public_relation.relnamespace = public_namespace.oid
     AND public_relation.relname = requested.name
    JOIN pg_constraint AS public_constraint ON public_constraint.conrelid = public_relation.oid
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_namespace AS final_namespace
      JOIN pg_class AS final_relation
        ON final_relation.relnamespace = final_namespace.oid
       AND final_relation.relname = requested.name
      JOIN pg_constraint AS final_constraint
        ON final_constraint.conrelid = final_relation.oid
       AND final_constraint.conname = public_constraint.conname
      WHERE final_namespace.nspname = $3
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM requested
    JOIN pg_namespace AS public_namespace ON public_namespace.nspname = 'public'
    JOIN pg_class AS public_relation
      ON public_relation.relnamespace = public_namespace.oid
     AND public_relation.relname = requested.name
    JOIN pg_index AS public_index ON public_index.indrelid = public_relation.oid
    JOIN pg_class AS public_index_relation ON public_index_relation.oid = public_index.indexrelid
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_namespace AS final_namespace
      JOIN pg_class AS final_relation
        ON final_relation.relnamespace = final_namespace.oid
       AND final_relation.relname = requested.name
      JOIN pg_index AS final_index ON final_index.indrelid = final_relation.oid
      JOIN pg_class AS final_index_relation
        ON final_index_relation.oid = final_index.indexrelid
       AND final_index_relation.relname = public_index_relation.relname
      WHERE final_namespace.nspname = $3
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM requested
    JOIN pg_namespace AS public_namespace ON public_namespace.nspname = 'public'
    JOIN pg_class AS public_relation
      ON public_relation.relnamespace = public_namespace.oid
     AND public_relation.relname = requested.name
    JOIN pg_trigger AS public_trigger
      ON public_trigger.tgrelid = public_relation.oid
     AND NOT public_trigger.tgisinternal
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_namespace AS final_namespace
      JOIN pg_class AS final_relation
        ON final_relation.relnamespace = final_namespace.oid
       AND final_relation.relname = requested.name
      JOIN pg_trigger AS final_trigger
        ON final_trigger.tgrelid = final_relation.oid
       AND final_trigger.tgname = public_trigger.tgname
       AND NOT final_trigger.tgisinternal
      WHERE final_namespace.nspname = $3
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM requested
    JOIN pg_namespace AS public_namespace ON public_namespace.nspname = 'public'
    JOIN pg_class AS public_relation
      ON public_relation.relnamespace = public_namespace.oid
     AND public_relation.relname = requested.name
    JOIN pg_policy AS public_policy ON public_policy.polrelid = public_relation.oid
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_namespace AS final_namespace
      JOIN pg_class AS final_relation
        ON final_relation.relnamespace = final_namespace.oid
       AND final_relation.relname = requested.name
      JOIN pg_policy AS final_policy
        ON final_policy.polrelid = final_relation.oid
       AND final_policy.polname = public_policy.polname
      WHERE final_namespace.nspname = $3
    )
  ) AS complete`;

function transactionalSql(sql: string): string {
  return sql
    .replace(/^\s*BEGIN;\s*/iu, "")
    .replace(/\s*COMMIT;\s*$/iu, "");
}

async function findCompleteMigrations(
  client: MigrationClient,
  migrations: readonly Migration[],
): Promise<ReadonlySet<string>> {
  const schemaSuffix = randomUUID().replaceAll("-", "");
  const finalSchema = `axiom_adoption_final_${schemaSuffix}`;
  const prefixSchema = `axiom_adoption_prefix_${schemaSuffix}`;
  const complete = new Set<string>();
  await client.query("BEGIN");
  try {
    await client.query(`CREATE SCHEMA "${finalSchema}"`);
    await client.query(`SET LOCAL search_path TO "${finalSchema}"`);
    for (const migration of migrations) {
      await client.query(`/* final canonical schema: ${migration.name} */\n${transactionalSql(migration.sql)}`);
    }

    await client.query(`CREATE SCHEMA "${prefixSchema}"`);
    await client.query(`SET LOCAL search_path TO "${prefixSchema}"`);
    let prefixIsComplete = true;
    for (const migration of migrations) {
      await client.query(`/* canonical schema for adoption: ${migration.name} */\n${transactionalSql(migration.sql)}`);
      const relations = migrationRelations[migration.name];
      if (!relations || !prefixIsComplete) {
        prefixIsComplete = false;
        continue;
      }
      await client.query("SET LOCAL search_path TO public");
      const result = await client.query(relationContractQuery, [relations, prefixSchema, finalSchema]);
      prefixIsComplete = result.rows?.[0]?.complete === true;
      if (prefixIsComplete) complete.add(migration.name);
      await client.query(`SET LOCAL search_path TO "${prefixSchema}"`);
    }
  } finally {
    await client.query("ROLLBACK");
  }
  return complete;
}

export async function loadMigrations(): Promise<readonly Migration[]> {
  return await Promise.all(migrationUrls.map(async (url) => {
    const sql = await readFile(fileURLToPath(url), "utf8");
    return {
      name: fileURLToPath(url).split("/").at(-1)!,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  }));
}

export async function applyMigrations(
  client: MigrationClient,
  migrations: readonly Migration[],
): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext('axiom-schema-migrations'))");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const completeMigrations = await findCompleteMigrations(client, migrations);
    for (const migration of migrations) {
      if (!completeMigrations.has(migration.name)) continue;
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
        [migration.name, migration.checksum],
      );
    }
    for (const migration of migrations) {
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [migration.name],
      );
      const checksum = applied.rows?.[0]?.checksum;
      if (typeof checksum === "string") {
        if (checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.name} has a different checksum`);
        }
        if (!completeMigrations.has(migration.name)) {
          throw new Error(`Applied migration ${migration.name} does not match its complete schema contract`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        const sql = transactionalSql(migration.sql);
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('axiom-schema-migrations'))");
  }
}

async function main(): Promise<void> {
  const databaseUrl = z.string().url().refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use postgres:// or postgresql://",
  ).parse(process.env.DATABASE_URL);
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await applyMigrations({
      query: async (text, parameters = []) => {
        const result = await client.query(text, [...parameters]);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
    }, await loadMigrations());
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
