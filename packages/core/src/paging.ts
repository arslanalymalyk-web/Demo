import type pg from "pg";

/** Keyset paging: a list is read newest first in pages, each page starting after the last row of the one before it. Unlike an offset, a row added or removed while someone is reading never makes a row repeat or vanish. */
export class PagingError extends Error { constructor(message: string) { super(message); } }
export interface Page<T> { rows: T[]; next: string | null; total: number }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encode = (ts: string, id: string): string => Buffer.from(JSON.stringify([ts, id])).toString("base64url");
function decode(cursor: string): [string, string] {
  try { const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (Array.isArray(v) && v.length === 2 && ISO.test(v[0]) && UUID.test(v[1])) return [v[0], v[1]]; } catch { /* fall through */ }
  throw new PagingError("the page marker is not valid; start again from the first page");
}
/** A search term as a LIKE pattern, with the characters that mean something to LIKE made literal. */
export const likePattern = (q: string): string => `%${q.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`;

export interface KeysetSpec {
  select: string;      // columns, written by the caller
  from: string;        // table and joins, written by the caller
  where?: string;      // conditions using numbered parameters, written by the caller; omitted means all rows
  params?: unknown[];  // values for the numbered parameters
  ts: string;          // timestamp column to order by (newest first)
  id: string;          // unique id column, the tiebreak
  limit: number;
  cursor?: string | undefined;
}

/** Reads one page, and the total number of rows the filters match. Everything in the spec except the values is fixed text from the calling module, never from a request. */
export async function keysetPage<T extends Record<string, unknown>>(c: pg.PoolClient, s: KeysetSpec): Promise<Page<T>> {
  if (!Number.isInteger(s.limit) || s.limit < 1 || s.limit > 500) throw new PagingError("the page size must be between 1 and 500");
  const params = [...(s.params ?? [])], where = s.where ? "(" + s.where + ")" : "TRUE";
  let after = "";
  if (s.cursor) {
    const [ts, id] = decode(s.cursor);
    params.push(ts, id);
    const a = params.length - 1, b = params.length;
    after = " AND (" + s.ts + ", " + s.id + ") < ($" + a + "::timestamptz, $" + b + "::uuid)";
  }
  const fmt = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'";
  const rows = (await c.query(
    "SELECT " + s.select + ", to_char(" + s.ts + " AT TIME ZONE 'UTC', " + fmt + ") AS _cur, " + s.id + "::text AS _id FROM " + s.from + " WHERE " + where + after + " ORDER BY " + s.ts + " DESC, " + s.id + " DESC LIMIT " + (s.limit + 1), params)).rows as (T & { _cur: string; _id: string })[];
  const more = rows.length > s.limit, kept = more ? rows.slice(0, s.limit) : rows;
  const total = (await c.query("SELECT count(*)::int AS n FROM " + s.from + " WHERE " + where, s.params ?? [])).rows[0].n as number;
  const last = kept[kept.length - 1];
  return { rows: kept.map(({ _cur, _id, ...rest }) => rest as unknown as T), next: more && last ? encode(last._cur, last._id) : null, total };
}
