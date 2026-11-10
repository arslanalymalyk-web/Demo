import { ApiError, currentToken } from "./api";

export async function downloadBlob(path: string): Promise<Blob> {
  const t = currentToken();
  const r = await fetch(`/api${path}`, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!r.ok) throw new ApiError(r.status, r.status === 403 ? "You do not have permission for this." : "Download failed.", null);
  return r.blob();
}
