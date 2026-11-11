/* eslint-disable security/detect-non-literal-fs-filename -- files in temporary test folders */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, ScanError } from "../scanners/common/job.js";
import { extractZip, ZIP_LIMITS, type ZipLimits } from "../scanners/common/unzip.js";
import { buildZip, type ZipEntry } from "./zip-builder.js";

let dir: string;
let dest: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unzip-test-"));
  dest = join(dir, "out");
  rmSync(dest, { recursive: true, force: true });
  mkdtempSync(dest);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function unzip(entries: readonly ZipEntry[], limits?: ZipLimits) {
  const file = join(dir, "upload.zip");
  writeFileSync(file, buildZip(entries));
  return extractZip(file, dest, limits);
}

async function refused(promise: Promise<unknown>): Promise<ScanError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScanError);
  const scanError = err as ScanError;
  expect(scanError.exitCode).toBe(EXIT.INPUT);
  expect(scanError.message).toMatch(/^The upload is not a safe zip: /);
  return scanError;
}

describe("extractZip", () => {
  it("unpacks files and folders, stored or compressed", async () => {
    const result = await unzip([
      { name: "app/" },
      { name: "app/views.py", data: "print('hi')\n" },
      { name: "app/deep/config.py", data: "x = 1\n".repeat(100), deflate: true },
    ]);
    expect(result).toEqual({ files: 2, bytes: 12 + 600, skipped: 0 });
    expect(readFileSync(join(dest, "app/views.py"), "utf8")).toBe("print('hi')\n");
    expect(readFileSync(join(dest, "app/deep/config.py"), "utf8")).toBe("x = 1\n".repeat(100));
  });

  it("leaves out .git folders and the __MACOSX folder", async () => {
    const result = await unzip([
      { name: "app/.git/config", data: "secret history" },
      { name: ".git/HEAD", data: "ref" },
      { name: "__MACOSX/app/._views.py", data: "mac junk" },
      { name: "app/views.py", data: "code" },
      { name: "app/my.gitignore", data: "kept" },
    ]);
    expect(result.files).toBe(2);
    expect(existsSync(join(dest, "app/.git"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(dest, "__MACOSX"))).toBe(false);
  });

  it("skips symbolic links instead of creating them", async () => {
    const result = await unzip([
      { name: "link", data: "/etc/passwd", mode: 0o120777 },
      { name: "real.txt", data: "ok" },
    ]);
    expect(result).toMatchObject({ files: 1, skipped: 1 });
    expect(existsSync(join(dest, "link"))).toBe(false);
  });

  it("skips files over the per-file limit without failing the scan", async () => {
    const limits = { ...ZIP_LIMITS, maxFileBytes: 100 };
    const result = await unzip(
      [
        { name: "big.min.js", data: "a".repeat(101) },
        { name: "small.js", data: "b" },
      ],
      limits,
    );
    expect(result).toMatchObject({ files: 1, skipped: 1 });
    expect(existsSync(join(dest, "big.min.js"))).toBe(false);
  });

  it.each([
    ["a path that climbs out with ..", "../../evil.sh"],
    ["a climb hidden in the middle", "app/../../evil.sh"],
    ["an absolute path", "/etc/cron.d/evil"],
    ["a Windows drive path", "C:/evil.bat"],
    ["Windows separators", "..\\..\\evil.bat"],
  ])("refuses %s", async (_what, name) => {
    await refused(unzip([{ name, data: "x" }]));
    expect(existsSync(join(dir, "evil.sh"))).toBe(false);
  });

  it("refuses a zip bomb: stops at the total limit on the bytes really written", async () => {
    const limits = { ...ZIP_LIMITS, maxTotalBytes: 10_000, maxFileBytes: 8000 };
    // Each file is under the per-file limit, together they are over the total.
    const bomb = Array.from({ length: 5 }, (_, i) => ({
      name: `zeros-${String(i)}.txt`,
      data: Buffer.alloc(4000),
      deflate: true,
    }));
    const err = await refused(unzip(bomb, limits));
    expect(err.message).toContain("unpacks to more than 10000 bytes");
  });

  it("refuses a file whose real size is not the size the zip claims", async () => {
    await refused(
      unzip([{ name: "liar.txt", data: Buffer.alloc(50_000), deflate: true, claimedSize: 10 }]),
    );
  });

  it("refuses a zip that lists more entries than allowed", async () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ name: `f${String(i)}`, data: "x" }));
    const err = await refused(unzip(entries, { ...ZIP_LIMITS, maxEntries: 3 }));
    expect(err.message).toContain("more than 3 entries");
  });

  it("refuses a zip that lists the same file twice", async () => {
    const err = await refused(
      unzip([
        { name: "a.py", data: "first" },
        { name: "a.py", data: "second" },
      ]),
    );
    expect(err.message).toContain("the same file twice");
    expect(readFileSync(join(dest, "a.py"), "utf8")).toBe("first");
  });

  it("refuses a file that is not a zip", async () => {
    const file = join(dir, "upload.zip");
    writeFileSync(file, "PK but not really a zip");
    await refused(extractZip(file, dest));
  });

  it("allows real code sizes by default", () => {
    expect(ZIP_LIMITS.maxTotalBytes).toBe(200 * 1024 * 1024);
    expect(ZIP_LIMITS.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(ZIP_LIMITS.maxEntries).toBe(20_000);
  });
});
