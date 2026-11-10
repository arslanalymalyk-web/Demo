import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Untrusted files go to external tools with no shell, a clean environment, a private temp directory and a time limit.
const ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1" };

export async function sandboxDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tigeris-doc-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
export const writeInput = async (dir: string, name: string, data: Buffer): Promise<string> => { const p = join(dir, name); await writeFile(p, data, { mode: 0o600 }); return p; };
export async function exec(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  const r = await run(cmd, args, { cwd, env: ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr };
}

let cache: Promise<ToolInfo> | null = null;
export interface ToolInfo { pdftotext: string | null; tesseract: string | null; languages: string[] }
export function tools(): Promise<ToolInfo> {
  cache ??= (async () => {
    const ver = async (cmd: string, args: string[]) => { try { const r = await exec(cmd, args, tmpdir(), 10_000); return (r.stdout + r.stderr).split("\n")[0]!.trim() || null; } catch { return null; } };
    const t = await ver("tesseract", ["--version"]);
    let languages: string[] = [];
    if (t) try { languages = (await exec("tesseract", ["--list-langs"], tmpdir(), 10_000)).stdout.split("\n").slice(1).map(s => s.trim()).filter(l => l && l !== "osd"); } catch { /* none */ }
    return { pdftotext: await ver("pdftotext", ["-v"]), tesseract: t, languages };
  })();
  return cache;
}
export { readFile, readdir };
