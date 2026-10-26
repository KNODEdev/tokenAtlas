import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SourceFolderListing } from "../shared/source-folders";

/** Directory names only; browsing never opens or imports files. */
export async function listSourceFolders(directory = os.homedir()): Promise<SourceFolderListing> {
  if (!path.isAbsolute(directory) || directory.replaceAll("/", "\\").startsWith("\\\\") || directory.includes("\0")) throw new Error("Choose an absolute local folder path.");
  const resolved = path.resolve(directory);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const roots = process.platform === "win32" ? (await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const drive = `${String.fromCharCode(65 + index)}:\\`;
    try { return (await fs.stat(drive)).isDirectory() ? drive : null; } catch { return null; }
  }))).filter((root): root is string => root !== null) : ["/"];
  return { path: resolved, parent: path.dirname(resolved) === resolved ? null : path.dirname(resolved), roots: [os.homedir(), ...roots],
    folders: entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}

export async function handleSourceFolders(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || req.headers.get("sec-fetch-site") === "cross-site" ||
      (req.headers.get("origin") && req.headers.get("origin") !== url.origin)) return Response.json({ error: "Local access only" }, { status: 403 });
  if (req.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  try { return Response.json(await listSourceFolders(url.searchParams.get("path") || undefined)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return Response.json({ error: code === "EACCES" || code === "EPERM" ? "No access to this folder." : code === "ENOENT" ? "Folder does not exist." : "Cannot open this local folder." }, { status: 400 });
  }
}
