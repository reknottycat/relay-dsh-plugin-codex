import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { readActivityPayload } from "../codex-activity-wire.mjs";

const LEGACY_TYPE = "relay-codex/activity";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function decodeFrames(bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    const decoded = zlib.zstdDecompressSync(bytes.subarray(offset), { info: true });
    const consumed = decoded.engine.bytesWritten;
    if (consumed <= 0) throw new Error("Invalid zstd frame length");
    frames.push(decoded.buffer);
    offset += consumed;
  }
  return Buffer.concat(frames);
}

// Stop DSH before applying: the file hash check detects changes, not a live writer lock.
export async function repairActivityHistory(path, { write = false } = {}) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Expected a regular session log, not a symlink");
  const compressed = path.endsWith(".jsonl.zstd");
  if (!compressed && !path.endsWith(".jsonl")) throw new Error("Unsupported log suffix");
  if (compressed && !zlib.zstdDecompressSync) throw new Error("Zstd repair requires Node with zstd support (22.15+)");
  const original = await readFile(path);
  const bytes = compressed ? decodeFrames(original) : original;
  const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!plaintext.endsWith("\n")) throw new Error("Refusing a torn session log");
  const lines = plaintext.slice(0, -1).split("\n");
  const header = JSON.parse(lines[0]);
  const supportedHeader = header.type === "session" && (header.version === 0 || header.version === 3);
  if (!supportedHeader || typeof header.id !== "string") {
    throw new Error("Unsupported session header");
  }
  let changed = 0;
  for (let i = 1; i < lines.length; i++) {
    const event = JSON.parse(lines[i]);
    if (event.type !== LEGACY_TYPE) continue;
    if (!readActivityPayload(event.data) || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error(`Refusing malformed legacy activity at record ${i}`);
    }
    if (event.ignorable === true) continue;
    if (event.ignorable !== undefined) throw new Error(`Invalid ignorable marker at record ${i}`);
    lines[i] = JSON.stringify({ ...event, ignorable: true });
    changed++;
  }
  const result = { path, sessionId: header.id, changed, written: false, sha256: hash(original) };
  if (!write || changed === 0) return result;
  // DSH requires a standalone first zstd frame containing only the header.
  const repaired = compressed
    ? Buffer.concat([
        zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`)),
        zlib.zstdCompressSync(Buffer.from(`${lines.slice(1).join("\n")}\n`)),
      ])
    : Buffer.from(`${lines.join("\n")}\n`);
  const backup = `${path}.before-codex-activity-${result.sha256}.bak`;
  try { await copyFile(path, backup, constants.COPYFILE_EXCL) }
  catch (error) { if (error.code !== "EEXIST") throw error }
  if (hash(await readFile(backup)) !== result.sha256) throw new Error("Backup verification failed");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", info.mode & 0o777);
    try { await handle.writeFile(repaired); await handle.sync() } finally { await handle.close() }
    if (hash(await readFile(path)) !== result.sha256) throw new Error("Session changed during repair; refusing replacement");
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await rm(temporary, { force: true });
  }
  return { ...result, written: true, backup };
}

export async function scanActivityHistories(root) {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("Expected a sessions directory, not a symlink");
  const report = { scanned: 0, affected: [], errors: [] };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && ["session.jsonl", "session.jsonl.zstd"].includes(entry.name)) {
        report.scanned++;
        try {
          const result = await repairActivityHistory(path);
          if (result.changed > 0) report.affected.push(result);
        } catch (error) {
          report.errors.push({ path, error: error.message });
        }
      }
    }
  }
  await visit(root);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const write = args[0] === "--write";
  const paths = write ? args.slice(1) : args;
  if (!paths.length) throw new Error("Usage: repair-activity-history.mjs [--write] <session.jsonl[.zstd]> ... | [--write] --root <sessions-directory> (stop DSH before --write)");
  if (paths[0] === "--root") {
    if (paths.length !== 2) throw new Error("--root requires exactly one sessions directory");
    const root = resolve(paths[1]);
    const report = await scanActivityHistories(root);
    console.log(JSON.stringify(report));
    if (report.errors.length > 0) throw new Error("Session scan incomplete; no batch repairs applied");
    if (write) {
      for (const { path } of report.affected) console.log(JSON.stringify(await repairActivityHistory(path, { write: true })));
      const remaining = await scanActivityHistories(root);
      console.log(JSON.stringify({ verification: remaining }));
      if (remaining.errors.length || remaining.affected.length) throw new Error("Session verification incomplete");
    }
  } else {
    for (const path of paths) console.log(JSON.stringify(await repairActivityHistory(resolve(path), { write })));
  }
}
