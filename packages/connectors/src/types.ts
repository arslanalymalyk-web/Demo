import type { RawRecord } from "../../core/src/index.js";
import type { PoliteHttp } from "./http.js";

export interface ConnectorContext { baseUrl: string; http: PoliteHttp; limit?: number; seriesKey?: string; localFile?: string }
export interface Connector { platform: string; fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> }
