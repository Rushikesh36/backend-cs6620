import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { EXIT, ScanError } from "./job.js";

/**
 * Limits for unpacking an uploaded zip. A "zip bomb" is a small zip that unpacks to something
 * huge; we stop on the bytes actually written, never trusting the sizes the zip claims.
 */
export interface ZipLimits {
  /** Most entries (files and folders) one zip may list. */
  maxEntries: number;
  /** Most bytes all files together may unpack to. Over this, the whole zip is refused. */
  maxTotalBytes: number;
  /** Files larger than this are skipped, not unpacked. Semgrep skips files over 1 MB anyway. */
  maxFileBytes: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
};

export interface UnzipResult {
  files: number;
  bytes: number;
  skipped: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Symbolic links are skipped: one could point the scanner at files outside the upload. */
const isSymlink = (entry: yauzl.Entry): boolean =>
  ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

/**
 * Not code to scan: git history (often most of a zip's size) and the __MACOSX folder that the
 * macOS Finder adds to every zip it makes.
 */
const isIgnoredFolder = (name: string): boolean =>
  /(^|\/)\.git\//.test(name) || name.startsWith("__MACOSX/");

const refuse = (reason: string): ScanError =>
  new ScanError(`The upload is not a safe zip: ${reason}`, EXIT.INPUT);

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    // lazyEntries: one entry at a time. validateEntrySizes: error if a file's real size differs
    // from what the zip says. yauzl also refuses absolute paths and ".." in names.
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) reject(refuse(err.message));
      else resolvePromise(zip);
    });
  });
}

/** Unpacks file into dest (which must exist). Throws ScanError(INPUT) for anything unsafe. */
export async function extractZip(
  file: string,
  dest: string,
  limits: ZipLimits = ZIP_LIMITS,
): Promise<UnzipResult> {
  const root = resolve(dest);
  const zip = await openZip(file);
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw refuse(`it lists more than ${String(limits.maxEntries)} entries.`);
  }

  const result: UnzipResult = { files: 0, bytes: 0, skipped: 0 };
  let total = 0;

  // Counts every byte written, across all files, and stops at the total limit.
  const counter = (): Transform =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > limits.maxTotalBytes) {
          callback(refuse(`it unpacks to more than ${String(limits.maxTotalBytes)} bytes.`));
        } else callback(null, chunk);
      },
    });

  async function extract(entry: yauzl.Entry): Promise<void> {
    const name = entry.fileName;
    if (name.endsWith("/") || isIgnoredFolder(name)) return;
    if (isSymlink(entry) || entry.isEncrypted() || entry.uncompressedSize > limits.maxFileBytes) {
      result.skipped += 1;
      return;
    }
    const target = resolve(root, name);
    const inside = relative(root, target);
    // yauzl already refuses "..", this is a second check that the file stays inside dest.
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === "..") {
      throw refuse(`the path ${name} leaves the upload folder.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const stream = await zip.openReadStreamPromise(entry);
    // "wx": never overwrite, so a zip listing the same file twice is refused.
    await pipeline(stream, counter(), createWriteStream(target, { flags: "wx" }));
    result.files += 1;
  }

  try {
    await new Promise<void>((resolvePromise, reject) => {
      zip.on("entry", (entry: yauzl.Entry) => {
        extract(entry).then(() => {
          zip.readEntry();
        }, reject);
      });
      zip.on("end", () => {
        resolvePromise();
      });
      zip.on("error", (err: Error) => {
        reject(err);
      });
      zip.readEntry();
    });
  } catch (err) {
    if (err instanceof ScanError) throw err;
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      throw refuse("it lists the same file twice.");
    }
    throw refuse(err instanceof Error ? err.message : String(err));
  } finally {
    zip.close();
  }
  result.bytes = total;
  return result;
}
