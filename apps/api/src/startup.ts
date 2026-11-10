import type pg from "pg";

export interface SafetyReport { ok: boolean; problems: string[] }

/** The tenancy guarantee rests on row-level security, which a superuser, a role with BYPASSRLS, or a table owner can sidestep.
 *  The API refuses to run as any of those, and refuses to run if an institution table does not force row-level security. */
export async function checkRuntimeSafety(pool: pg.Pool): Promise<SafetyReport> {
  const problems: string[] = [];
  const role = (await pool.query("SELECT current_user AS name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb FROM pg_roles r WHERE r.rolname = current_user")).rows[0];
  if (role.rolsuper) problems.push(`the database role ${role.name} is a superuser`);
  if (role.rolbypassrls) problems.push(`the database role ${role.name} can bypass row-level security`);
  if (role.rolcreaterole || role.rolcreatedb) problems.push(`the database role ${role.name} can create roles or databases`);
  const owned = (await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user")).rows[0].n as number;
  if (owned > 0) problems.push(`the database role ${role.name} owns ${owned} table(s); the runtime role must not own anything`);
  const open = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'institution_id' AND NOT a.attisdropped)
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity) ORDER BY 1`)).rows.map(r => r.relname as string);
  if (open.length) problems.push(`row-level security is not forced on: ${open.join(", ")}`);
  const ext = (await pool.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pgcrypto'")).rows[0].n as number;
  if (!ext) problems.push("the pgcrypto extension is missing, so the audit chain cannot be written");
  return { ok: problems.length === 0, problems };
}
