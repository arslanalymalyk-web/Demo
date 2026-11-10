import { readFileSync } from "node:fs";
import { opendatasoft } from "./opendatasoft.js";
import { ckan } from "./ckan.js";
import { tesseract } from "./tesseract.js";
import { seriesConnector, type SeriesSpec } from "./series.js";
import { imfCommodityPrices, jodiConnector } from "./files.js";
import type { Connector } from "./types.js";
export { PoliteHttp } from "./http.js";
export type { Connector, ConnectorContext } from "./types.js";
export { opendatasoft, ckan, tesseract, seriesConnector, type SeriesSpec };
export { toValidTime } from "./series.js";
export { parseImfSheet, parseJodiCsv, imfCommodityPrices, jodiConnector } from "./files.js";
const catalogue: Record<string, Connector> = { opendatasoft, ckan, tesseract };

/** Picks a connector by platform. Mode "series" reads numeric observations from the series definition files. */
export function connectorFor(platform: string, mode: "catalog" | "series" = "catalog", sourceKey = ""): Connector | undefined {
  if (mode === "series") {
    if (platform === "files") {
      if (sourceKey.includes("imf-commodity")) return imfCommodityPrices;
      if (sourceKey.includes("jodi")) return jodiConnector([2022, 2023, 2024, 2025, 2026]);
      return undefined;
    }
    if (platform !== "tesseract") return undefined;
    const specs = JSON.parse(readFileSync(new URL("../../../data/series/datasaudi.json", import.meta.url), "utf8")) as SeriesSpec[];
    return seriesConnector(specs);
  }
  return catalogue[platform];
}
