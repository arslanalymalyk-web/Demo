import type pg from "pg";
import { canonicalJson, sha256Hex, type DataClass } from "../../core/src/index.js";

export type EntityKind = "country" | "chokepoint" | "commodity" | "institution" | "facility" | "route" | "mandate" | "portfolio" | "indicator";
export type LinkClass = "observed" | "sourced" | "inferred" | "assumed" | "sample";

export interface EntityInput { kind: EntityKind; key: string; name: string; attrs?: Record<string, unknown>; dataClass?: DataClass }
export interface LinkInput {
  subject: string; predicate: string; object: string; linkClass: LinkClass;
  params?: Record<string, unknown>; rationale?: string; author?: string;
  evidence?: { evidenceId: string; role: "supports" | "contradicts" | "context" }[];
}
export interface PathEdge { id: string; from: string; to: string; predicate: string; linkClass: LinkClass; params: Record<string, unknown>; rationale: string | null; evidence: string[] }
export interface GraphPath { depth: number; edges: PathEdge[] }

/** Relational adjacency graph for one institution. All reads and writes run inside a tenant transaction. */
export class PostgresGraph {
  constructor(private c: pg.PoolClient, private institutionId: string) {}

  async upsertEntity(e: EntityInput): Promise<string> {
    const r = await this.c.query(
      `INSERT INTO entities (institution_id, kind, key, name, attrs, data_class) VALUES ($1,$2::entity_kind,$3,$4,$5,$6::data_class)
       ON CONFLICT (institution_id, key) DO UPDATE SET name = EXCLUDED.name, attrs = EXCLUDED.attrs RETURNING id, kind`,
      [this.institutionId, e.kind, e.key, e.name, JSON.stringify(e.attrs ?? {}), e.dataClass ?? "public_record"]);
    if (r.rows[0].kind !== e.kind) throw new Error(`entity ${e.key} already exists with kind ${r.rows[0].kind}`);
    return r.rows[0].id as string;
  }

  private async idOf(key: string): Promise<string> {
    const r = await this.c.query("SELECT id FROM entities WHERE key = $1", [key]);
    if (!r.rows[0]) throw new Error(`unknown entity ${key}`);
    return r.rows[0].id as string;
  }

  /** Adds a link. An identical active link is returned unchanged; a changed one retires the old version. */
  async addLink(l: LinkInput): Promise<string> {
    const [s, o] = [await this.idOf(l.subject), await this.idOf(l.object)];
    const same = await this.c.query("SELECT id, link_class, params, rationale FROM relationships WHERE subject_id=$1 AND object_id=$2 AND predicate=$3 AND status='active'", [s, o, l.predicate]);
    const old = same.rows[0];
    if (old) {
      if (old.link_class === l.linkClass && canonicalJson(old.params) === canonicalJson(l.params ?? {}) && (old.rationale ?? null) === (l.rationale ?? null)) return old.id as string;
      await this.c.query("UPDATE relationships SET status='retired', valid_to=now() WHERE id=$1", [old.id]);
    }
    const r = await this.c.query(
      `INSERT INTO relationships (institution_id, subject_id, predicate, object_id, link_class, params, rationale, author) VALUES ($1,$2,$3,$4,$5::link_class,$6,$7,$8) RETURNING id`,
      [this.institutionId, s, l.predicate, o, l.linkClass, JSON.stringify(l.params ?? {}), l.rationale ?? null, l.author ?? null]);
    const id = r.rows[0].id as string;
    for (const ev of l.evidence ?? []) await this.c.query("INSERT INTO relationship_evidence (institution_id, relationship_id, evidence_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [this.institutionId, id, ev.evidenceId, ev.role]);
    return id;
  }

  /** All directed paths from an entity up to maxDepth links. A path never revisits an entity, so cycles end. */
  async paths(fromKey: string, maxDepth = 3): Promise<GraphPath[]> {
    const start = await this.idOf(fromKey);
    const walk = await this.c.query(
      `WITH RECURSIVE walk AS (
         SELECT ARRAY[r.id] AS edges, ARRAY[r.subject_id, r.object_id] AS visited, r.object_id AS tip, 1 AS depth
         FROM relationships r WHERE r.subject_id = $1 AND r.status = 'active'
         UNION ALL
         SELECT w.edges || r.id, w.visited || r.object_id, r.object_id, w.depth + 1
         FROM walk w JOIN relationships r ON r.subject_id = w.tip AND r.status = 'active'
         WHERE w.depth < $2 AND NOT (r.object_id = ANY (w.visited)))
       SELECT edges, depth FROM walk ORDER BY depth, edges`, [start, Math.min(Math.max(maxDepth, 1), 6)]);
    const ids = [...new Set(walk.rows.flatMap(r => r.edges as string[]))];
    if (ids.length === 0) return [];
    const det = await this.c.query(
      `SELECT r.id, s.key AS from_key, o.key AS to_key, r.predicate, r.link_class, r.params, r.rationale,
              COALESCE((SELECT array_agg(evidence_id::text ORDER BY evidence_id) FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'supports'), '{}') AS evidence
       FROM relationships r JOIN entities s ON s.id = r.subject_id JOIN entities o ON o.id = r.object_id WHERE r.id = ANY($1::uuid[])`, [ids]);
    const byId = new Map<string, PathEdge>(det.rows.map(r => [r.id, { id: r.id, from: r.from_key, to: r.to_key, predicate: r.predicate, linkClass: r.link_class, params: r.params, rationale: r.rationale, evidence: r.evidence }]));
    return walk.rows.map(r => ({ depth: r.depth, edges: (r.edges as string[]).map(id => byId.get(id)!) }));
  }

  /** Entities reached by one active link of the given predicate, with the link's class and parameters. */
  async linked(fromKey: string, predicate: string): Promise<{ key: string; name: string; attrs: Record<string, unknown>; linkClass: LinkClass; params: Record<string, unknown> }[]> {
    const start = await this.idOf(fromKey);
    const r = await this.c.query(
      `SELECT o.key, o.name, o.attrs, r.link_class, r.params FROM relationships r JOIN entities o ON o.id = r.object_id
       WHERE r.subject_id = $1 AND r.predicate = $2 AND r.status = 'active' ORDER BY o.key`, [start, predicate]);
    return r.rows.map(x => ({ key: x.key, name: x.name, attrs: x.attrs, linkClass: x.link_class, params: x.params }));
  }

  /** Freezes the active graph into a hashed manifest so a scenario can be replayed against the exact same structure. */
  async snapshot(): Promise<{ id: string; hash: string; created: boolean; entities: number; relationships: number }> {
    const ents = (await this.c.query("SELECT key, kind, name, attrs, data_class FROM entities ORDER BY key")).rows;
    const rels = (await this.c.query(
      `SELECT s.key AS subject, r.predicate, o.key AS object, r.link_class, r.params, r.rationale,
              COALESCE((SELECT array_agg(evidence_id::text ORDER BY evidence_id) FROM relationship_evidence e WHERE e.relationship_id = r.id AND e.role = 'supports'), '{}') AS evidence
       FROM relationships r JOIN entities s ON s.id = r.subject_id JOIN entities o ON o.id = r.object_id WHERE r.status = 'active' ORDER BY s.key, r.predicate, o.key`)).rows;
    const manifest = { entities: ents, relationships: rels };
    const hash = sha256Hex(canonicalJson(manifest));
    const ins = await this.c.query(
      `INSERT INTO graph_snapshots (institution_id, content_hash, entity_count, relationship_count, manifest) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (institution_id, content_hash) DO NOTHING RETURNING id`,
      [this.institutionId, hash, ents.length, rels.length, JSON.stringify(manifest)]);
    if (ins.rows[0]) return { id: ins.rows[0].id, hash, created: true, entities: ents.length, relationships: rels.length };
    const ex = await this.c.query("SELECT id FROM graph_snapshots WHERE content_hash = $1", [hash]);
    return { id: ex.rows[0].id, hash, created: false, entities: ents.length, relationships: rels.length };
  }
}
