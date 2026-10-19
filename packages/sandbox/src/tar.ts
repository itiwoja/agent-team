// 作業場のファイルの控え（tar.gz）の読み書き。依存を増やさないよう ustar の通常ファイルだけを扱う最小の実装。
// 読むときは「..」・絶対パス・通常ファイル以外（リンク・デバイス）を捨てる（控えは信頼しない：ADR-020）

import { gunzipSync, gzipSync } from "node:zlib";

export interface ArchiveFile {
  /** 作業場の根からの相対パス（区切りは /） */
  path: string;
  content: Buffer;
  /** 実行できるか（スクリプト） */
  executable?: boolean;
}

const BLOCK = 512;

/** パスを正規化する。作業場の外を指す・空・絶対パスは null */
export function safeRelativePath(p: string): string | null {
  if (typeof p !== "string") return null;
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.includes("\0")) return null;
    parts.push(seg);
  }
  if (parts.length === 0 || p.startsWith("/")) return null;
  return parts.join("/");
}

function writeString(buf: Buffer, offset: number, len: number, value: string): void {
  buf.write(value, offset, Math.min(len, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  writeString(buf, offset, len, `${value.toString(8).padStart(len - 1, "0")}\0`);
}

function header(path: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // ustar の prefix（155バイト）に前半のディレクトリを入れる
    const cut = path.lastIndexOf("/", 154);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new RangeError(`パスが長すぎる：${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // チェックサムの欄は計算のあいだ空白
  h.write("0", 156, "utf8"); // 通常ファイル
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** ファイルの一覧から tar.gz を作る（パスの順に並べる：同じ中身なら同じバイト列） */
export function createTarGz(files: readonly ArchiveFile[], mtime = 0): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const path = safeRelativePath(f.path);
    if (path === null) throw new RangeError(`作業場の外を指すパス：${f.path}`);
    chunks.push(header(path, f.content.length, f.executable ? 0o755 : 0o644, mtime));
    chunks.push(f.content);
    const pad = (BLOCK - (f.content.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function readString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, len: number): number {
  const s = readString(buf, offset, len).trim();
  return s === "" ? 0 : parseInt(s, 8);
}

/**
 * tar.gz を読む。通常ファイルだけを返し、作業場の外を指すパス・リンクなどは捨てる。
 * 展開後の合計が maxBytes を超えたら RangeError（展開爆弾を防ぐ）
 */
export function readTarGz(archive: Buffer, maxBytes = 64 * 1024 * 1024): ArchiveFile[] {
  const tar = gunzipSync(archive, { maxOutputLength: maxBytes + BLOCK * 4 });
  const out: ArchiveFile[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const size = readOctal(h, 124, 12);
    const mode = readOctal(h, 100, 8);
    const type = String.fromCharCode(h[156] ?? 0x30);
    off += BLOCK;
    if (!Number.isFinite(size) || size < 0 || off + size > tar.length) throw new RangeError("tar が壊れている");
    const content = tar.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type !== "0" && type !== "\0") continue;
    const path = safeRelativePath(prefix === "" ? name : `${prefix}/${name}`);
    if (path === null) continue;
    out.push({ path, content: Buffer.from(content), executable: (mode & 0o111) !== 0 });
  }
  return out;
}
