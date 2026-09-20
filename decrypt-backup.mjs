#!/usr/bin/env node
/**
 * decrypt-backup.mjs — Decrypt and inspect a .tar.gz.enc backup file
 *
 * File format written by the backup worker:
 *   [12 bytes IV][AES-256-GCM encrypted gzipped tar][16 bytes GCM auth tag]
 *
 * Usage:
 *   BACKUP_ENCRYPTION_KEY=<hex> node decrypt-backup.mjs <file.tar.gz.enc> [output-dir]
 *
 * Examples:
 *   # List contents only (no extraction)
 *   BACKUP_ENCRYPTION_KEY=f606... node decrypt-backup.mjs backup.tar.gz.enc
 *
 *   # Extract to a directory
 *   BACKUP_ENCRYPTION_KEY=f606... node decrypt-backup.mjs backup.tar.gz.enc ./restored
 *
 * The BACKUP_ENCRYPTION_KEY is the hex value from apps/api/.env
 */

import { open, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

// ── Args ──────────────────────────────────────────────────────────────────────
const [, , encFile, outDir] = process.argv;

if (!encFile) {
  console.error('Usage: BACKUP_ENCRYPTION_KEY=<hex> node decrypt-backup.mjs <file.tar.gz.enc> [output-dir]');
  process.exit(1);
}

if (!existsSync(encFile)) {
  console.error(`File not found: ${encFile}`);
  process.exit(1);
}

const keyHex = process.env.BACKUP_ENCRYPTION_KEY;
if (!keyHex || keyHex.length !== 64) {
  console.error('Error: BACKUP_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes).');
  console.error('Find it in apps/api/.env');
  process.exit(1);
}

// ── Read IV (first 12 bytes) and auth tag (last 16 bytes) ────────────────────
const fh = await open(encFile, 'r');
const { size } = await fh.stat();

if (size < 12 + 16) {
  console.error('File too small — not a valid .tar.gz.enc backup.');
  await fh.close();
  process.exit(1);
}

const ivBuf  = Buffer.alloc(12);
const tagBuf = Buffer.alloc(16);
await fh.read(ivBuf,  0, 12, 0);
await fh.read(tagBuf, 0, 16, size - 16);
await fh.close();

// Ciphertext occupies bytes [12 .. size-16)
const key      = Buffer.from(keyHex, 'hex');
const decipher = createDecipheriv('aes-256-gcm', key, ivBuf);
decipher.setAuthTag(tagBuf);

console.log(`\nBackup file : ${encFile}`);
console.log(`File size   : ${(size / 1024 / 1024).toFixed(2)} MB`);
console.log(`IV (hex)    : ${ivBuf.toString('hex')}`);
console.log(`Auth tag    : ${tagBuf.toString('hex')}`);

// ── Decrypt + gunzip to a temp .tar ──────────────────────────────────────────
const tmpTar = encFile.replace(/\.enc$/, '').replace(/\.gz$/, '') + '.tmp.tar';

console.log(`\nDecrypting…`);

try {
  const readStream = createReadStream(encFile, { start: 12, end: size - 17 });
  const gunzip     = createGunzip();
  const writeStream = createWriteStream(tmpTar);

  await pipeline(readStream, decipher, gunzip, writeStream);
  console.log('Decryption OK ✓  (GCM auth tag verified)');
} catch (err) {
  console.error('\n❌ Decryption failed:', err.message);
  console.error('Possible causes:');
  console.error('  • Wrong BACKUP_ENCRYPTION_KEY');
  console.error('  • File is corrupt or truncated');
  console.error('  • File was created with an older version of the backup worker (missing auth tag)');
  // clean up
  try { await import('node:fs/promises').then(m => m.rm(tmpTar, { force: true })); } catch (_) {}
  process.exit(1);
}

// ── List or extract ───────────────────────────────────────────────────────────
if (outDir) {
  await mkdir(outDir, { recursive: true });
  console.log(`\nExtracting to ${outDir}/…`);
  await execFileAsync('tar', ['-xf', tmpTar, '-C', outDir]);
  console.log('Done! Contents:');
  const { stdout } = await execFileAsync('find', [outDir, '-type', 'f']);
  console.log(stdout.trim());
} else {
  console.log('\nContents (pass an output-dir to extract):');
  // tar -tzf won't work on a plain .tar (not gzipped) — use -tf
  const { stdout } = await execFileAsync('tar', ['-tf', tmpTar]);
  console.log(stdout.trim());
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
import { rm } from 'node:fs/promises';
await rm(tmpTar, { force: true });
