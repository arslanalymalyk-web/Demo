import { readFileSync } from "node:fs";
import readXlsxFile from "read-excel-file/node";
import type { ObservationFact, RawRecord } from "../../core/src/index.js";
import type { Connector, ConnectorContext } from "./types.js";

// ---------- IMF primary commodity prices (monthly workbook) ----------

const IMF_FILE = "https://www.imf.org/-/media/files/research/commodityprices/monthly/external-data.xlsx";
const IMF_KEY = "imf-commodity-prices-monthly";

export interface ImfParsed { facts: ObservationFact[]; commodities: number; missing: number; latest: string | null }

/** Parses the workbook grid: row 0 codes, row 1 descriptions, row 2 data type, row 3 frequency, then one row per month ("1980M1"). */
export function parseImfSheet(grid: unknown[][]): ImfParsed {
  const codes = grid[0] ?? [], desc = grid[1] ?? [], type = grid[2] ?? [];
  const facts: ObservationFact[] = []; let missing = 0; let latest: string | null = null;
  const meta = codes.map((c, i) => {
    if (i === 0 || typeof c !== "string" || !c) return null;
    const d = String(desc[i] ?? ""); const isIndex = type[i] === "Index";
    const base = /(\d{4}) = 100/.exec(d)?.[1];
    const unit = isIndex ? (base ? `index (${base} = 100)` : "index") : (d.split(",").at(-1)?.trim() || null);
    const name = d.split(",").slice(0, 2).map(x => x.trim()).join(", ");
    return { code: c, name, isIndex, unit, unitStated: isIndex ? Boolean(base) : /per /i.test(d) };
  });
  for (let r = 4; r < grid.length; r++) {
    const row = grid[r]!; const m = /^(\d{4})M(\d{1,2})$/.exec(String(row[0] ?? ""));
    if (!m) continue;
    const validTime = `${m[1]}-${m[2]!.padStart(2, "0")}-01T00:00:00.000Z`;
    for (let i = 1; i < row.length; i++) {
      const c = meta[i]; if (!c) continue;
      const v = row[i];
      if (typeof v !== "number" || !Number.isFinite(v)) { missing++; continue; }
      facts.push({ subject: `${IMF_KEY}|commodity=${c.code}`, predicate: c.isIndex ? "Price index" : "Price", value: v, unit: c.unit, unitStated: c.unitStated, validTime, dims: { period: String(row[0]), commodity: c.code, name: c.name } });
      if (!latest || validTime > latest) latest = validTime;
    }
  }
  return { facts, commodities: meta.filter(Boolean).length, missing, latest };
}

export const imfCommodityPrices: Connector = {
  platform: "files",
  async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
    const buf = ctx.localFile ? readFileSync(ctx.localFile) : await ctx.http.getBuffer(IMF_FILE);
    const sheets = await readXlsxFile(buf);
    const grid = (sheets.find(s => s.sheet === "External") ?? sheets[0])!.data as unknown[][];
    const p = parseImfSheet(grid);
    yield {
      externalKey: `series:${IMF_KEY}`, kind: "observation", sourceUrl: "https://www.imf.org/en/Research/commodity-prices", originalAgency: "International Monetary Fund",
      eventTime: p.latest, transformation: "IMF workbook sheet External; one fact per commodity and month; period converted to month start (UTC)" + (ctx.localFile ? "; imported from a manually supplied copy of the published file" : ""),
      series: { key: IMF_KEY, title: "IMF primary commodity prices (monthly)", description: "Monthly prices and price indices for energy, metals, food and other commodities.", frequency: "monthly", packs: ["energy", "sovereign_capital"], maxAgeDays: 120, query: { file: IMF_FILE, sheet: "External" } },
      payload: { file: IMF_FILE, retrieval: ctx.localFile ? "manual_import" : "download", commodities: p.commodities, observations: p.facts.length, missingCells: p.missing, nullMeasures: p.missing, header: { codes: grid[0], descriptions: grid[1], dataTypes: grid[2] }, latestPeriod: p.latest },
      facts: p.facts,
    };
  },
};

// ---------- JODI Oil World Database, primary products (annual CSV files) ----------

const JODI_ORIGIN = "https://www.jodidata.org/_resources/files/downloads/oil-data/annual-csv/primary";
const JODI_KEY = "jodi-gulf-crude-monthly";
const GULF: Record<string, string> = { SA: "Saudi Arabia", AE: "United Arab Emirates", QA: "Qatar", KW: "Kuwait", BH: "Bahrain", OM: "Oman", IQ: "Iraq", IR: "Iran" };
const FLOWS: Record<string, { label: string; unit: string; code: string }> = {
  INDPROD: { label: "Indigenous production", unit: "thousand barrels per day", code: "KBD" },
  TOTEXPSB: { label: "Total exports", unit: "thousand barrels per day", code: "KBD" },
  TOTIMPSB: { label: "Total imports", unit: "thousand barrels per day", code: "KBD" },
  REFINOBS: { label: "Refinery intake (observed)", unit: "thousand barrels per day", code: "KBD" },
  CLOSTLV: { label: "Closing stocks", unit: "thousand barrels", code: "KBBL" },
};

export interface JodiParsed { facts: ObservationFact[]; rows: Record<string, string>[]; missing: number; latest: string | null }

/** Keeps total crude oil for the Gulf producers and the flows above. Values "x" and "-" are missing, not zero. */
export function parseJodiCsv(text: string): JodiParsed {
  const facts: ObservationFact[] = []; const rows: Record<string, string>[] = []; let missing = 0; let latest: string | null = null;
  const lines = text.split(/\r?\n/); const head = (lines[0] ?? "").split(",");
  const ix = (n: string) => head.indexOf(n);
  const [iA, iT, iP, iF, iU, iV, iQ] = ["REF_AREA", "TIME_PERIOD", "ENERGY_PRODUCT", "FLOW_BREAKDOWN", "UNIT_MEASURE", "OBS_VALUE", "ASSESSMENT_CODE"].map(ix) as [number, number, number, number, number, number, number];
  if ([iA, iT, iP, iF, iU, iV, iQ].some(i => i < 0)) throw new Error("unexpected JODI header: " + head.join(","));
  for (let l = 1; l < lines.length; l++) {
    const c = lines[l]!.split(","); if (c.length < head.length) continue;
    const area = c[iA]!, product = c[iP]!, flow = c[iF]!, unit = c[iU]!;
    const spec = FLOWS[flow];
    if (!GULF[area] || product !== "TOTCRUDE" || !spec || unit !== spec.code) continue;
    const m = /^(\d{4})-(\d{2})$/.exec(c[iT]!); if (!m) continue;
    const num = Number(c[iV]); const ok = c[iV] !== "" && c[iV] !== "x" && c[iV] !== "-" && Number.isFinite(num);
    rows.push({ area, period: c[iT]!, flow, unit, value: c[iV]!, assessment: c[iQ]! });
    if (!ok) { missing++; continue; }
    const validTime = `${m[1]}-${m[2]}-01T00:00:00.000Z`;
    facts.push({ subject: `${JODI_KEY}|country=${area}|flow=${flow}`, predicate: spec.label, value: num, unit: spec.unit, unitStated: true, validTime, dims: { period: c[iT]!, country: area, countryName: GULF[area]!, flow, assessmentCode: c[iQ]! } });
    if (!latest || validTime > latest) latest = validTime;
  }
  return { facts, rows, missing, latest };
}

export function jodiConnector(years: number[]): Connector {
  return {
    platform: "files",
    async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
      for (const year of years) {
        const url = year >= 2026 ? `${JODI_ORIGIN}/primaryyear${year}.csv` : `${JODI_ORIGIN}/${year}.csv`;
        const p = parseJodiCsv((await ctx.http.getBuffer(url)).toString("utf8"));
        yield {
          externalKey: `series:${JODI_KEY}:${year}`, kind: "observation", sourceUrl: url, originalAgency: "JODI (Joint Organisations Data Initiative)", eventTime: p.latest,
          transformation: "JODI primary CSV; filtered to total crude oil, Gulf producers and selected flows; x and - treated as missing; period converted to month start (UTC)",
          series: { key: JODI_KEY, title: "Gulf crude oil: production, trade, intake and stocks (monthly, JODI)", description: "Monthly total crude oil data reported by Gulf producers to JODI.", frequency: "monthly", packs: ["energy"], maxAgeDays: 150, query: { years, product: "TOTCRUDE", countries: Object.keys(GULF), flows: Object.keys(FLOWS) } },
          payload: { year, file: url, rowsKept: p.rows.length, nullMeasures: p.missing, data: p.rows },
          facts: p.facts,
        };
      }
    },
  };
}
