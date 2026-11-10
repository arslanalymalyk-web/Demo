import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { episodeBacktestIfStored } from "../packages/scenario/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("a deployment without the back-test history", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  it("says the episode is not covered instead of failing, found by the browser suite on a fresh institution", async () => {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'H')", [id]); });
    const token = await addUser(owner, app, id, "ana", ["analyst"]);
    expect(await withTenant(app, id, c => episodeBacktestIfStored(c, id))).toBeNull();
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const r = await server.inject({ method: "GET", url: "/v1/scenarios/backtest", headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ available: false, reason: expect.stringMatching(/Source not connected/) });
    await server.close();
  });
});
