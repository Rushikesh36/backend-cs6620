import { crc32, deflateRawSync } from "node:zlib";

/**
 * Builds zip files byte by byte for the unzip tests, including broken and hostile ones that
 * normal zip tools refuse to make (paths with "..", sizes that lie, symbolic links).
 */
export interface ZipEntry {
  name: string;
  data?: Buffer | string;
  /** Compress with deflate (zip method 8) instead of storing. */
  deflate?: boolean;
  /** Unix file mode, for example 0o120777 for a symbolic link. */
  mode?: number;
  /** Uncompressed size written in the headers, if it should lie about the real size. */
  claimedSize?: number;
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data ?? "");
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(raw);
    const size = entry.claimedSize ?? raw.length;
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below counts
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
