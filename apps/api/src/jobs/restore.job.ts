import { Worker, Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv, DecipherGCM } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';

const execFileAsync = promisify(execFile);
const ENCRYPTION_KEY_HEX = process.env.BACKUP_ENCRYPTION_KEY;

export interface RestoreJobPayload {
  restoreRunId: string;
}

export function startRestoreWorker() {
  const worker = new Worker(
    'restore',
    async (job: Job<RestoreJobPayload>) => {
      const { restoreRunId } = job.data;

      const restoreRun = await prisma.restoreRun.findUnique({
        where: { id: restoreRunId },
        include: {
          backupRun: { include: { job: { include: { connection: true } } } },
          targetConnection: true,
        },
      });
      if (!restoreRun) return; // stale — ignore

      // Mark as running
      await prisma.restoreRun.update({
        where: { id: restoreRunId },
        data: { status: 'running', startedAt: new Date() },
      });

      const tempDir = path.join('/tmp', `restore-${restoreRunId}`);
      const extractDir = path.join(tempDir, 'extracted');
      const dumpDir = path.join(extractDir, 'dump');
      const decryptedTar = path.join(tempDir, 'backup.tar.gz');

      try {
        await mkdir(extractDir, { recursive: true });

        const encryptedFilePath = restoreRun.backupRun.filePath;
        if (!encryptedFilePath) throw new Error('Backup file path is missing');

        const isEncrypted = encryptedFilePath.endsWith('.enc');

        if (isEncrypted) {
          if (!ENCRYPTION_KEY_HEX) {
            throw new Error('BACKUP_ENCRYPTION_KEY is not set but the backup file is encrypted');
          }

          // ── STEP 1: Read IV (first 12 bytes) and auth tag (last 16 bytes) ──
          const fileHandle = await open(encryptedFilePath, 'r');
          const stats = await fileHandle.stat();
          const totalSize = stats.size;

          const ivBuffer = Buffer.alloc(12);
          await fileHandle.read(ivBuffer, 0, 12, 0);

          const tagBuffer = Buffer.alloc(16);
          await fileHandle.read(tagBuffer, 0, 16, totalSize - 16);
          await fileHandle.close();

          // ── STEP 2: Stream-decrypt the middle [12 .. size-16) ──
          const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
          const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer) as DecipherGCM;
          decipher.setAuthTag(tagBuffer);

          // createReadStream `end` is INCLUSIVE — so to read up to (but not including)
          // totalSize-16 we use end = totalSize - 17.
          const encryptedStream = createReadStream(encryptedFilePath, {
            start: 12,
            end: totalSize - 17,
          });
          const gunzip = createGunzip();
          const tarWriteStream = createWriteStream(decryptedTar);

          await pipeline(encryptedStream, decipher, gunzip, tarWriteStream);
        } else {
          // Unencrypted .tar.gz — just gunzip into a .tar
          const readStream = createReadStream(encryptedFilePath);
          const gunzip = createGunzip();
          const tarWriteStream = createWriteStream(decryptedTar);
          await pipeline(readStream, gunzip, tarWriteStream);
        }

        // ── STEP 3: Extract tar ──
        await execFileAsync('tar', ['-xf', decryptedTar, '-C', extractDir]);

        // ── STEP 4: Decrypt target URI ──
        const targetUri = decrypt(restoreRun.targetConnection.encryptedUri);

        // ── STEP 5: Run the engine-appropriate restore tool ──
        // The encrypt/extract pipeline above is identical for every engine —
        // the dump format in `extractDir` differs, and so does the CLI we use
        // to ingest it on the target.
        const targetDbType = restoreRun.targetConnection.dbType;
        const log = await runEngineRestore(targetDbType, targetUri, extractDir, dumpDir);
        await prisma.restoreRun.update({
          where: { id: restoreRunId },
          data: { status: 'success', finishedAt: new Date(), log },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.restoreRun.update({
          where: { id: restoreRunId },
          data: { status: 'failed', finishedAt: new Date(), log: message },
        });
        throw err;
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
    },
    {
      connection: redis,
      concurrency: 1, // Never run two restores simultaneously
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[RestoreWorker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine-specific restore helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch by target engine. Returns the combined stdout+stderr of the
 * restore tool for logging in `RestoreRun.log`.
 *
 * Each branch assumes the backup was created by the matching engine in
 * `backup.job.ts`:
 *   - Mongo  → `extractDir/dump/<db>/...` (mongodump output)
 *   - PG     → `extractDir/dump/pg.dump`  (pg_dump custom format)
 *   - MySQL  → `extractDir/dump/mysql.sql` (mysqldump SQL script)
 *
 * Cross-engine restore is not supported (you can't pg_restore a Mongo dump).
 * The route layer should refuse that combination before enqueuing.
 */
async function runEngineRestore(
  dbType: string,
  targetUri: string,
  extractDir: string,
  dumpDir: string,
): Promise<string> {
  if (dbType === 'mongodb') {
    return runMongoRestore(targetUri, dumpDir);
  }
  if (dbType === 'postgres') {
    return runPostgresRestore(targetUri, extractDir);
  }
  if (dbType === 'mysql') {
    return runMysqlRestore(targetUri, extractDir);
  }
  throw new Error(`Restore not supported for target dbType "${dbType}"`);
}

async function runMongoRestore(uri: string, dumpDir: string): Promise<string> {
  // NOTE: --preserveUUID intentionally omitted (needs applyOps, blocked on Atlas).
  // NOTE: --tlsInsecure intentionally omitted (breaks SNI on Atlas LB).
  //
  // ⚠️ Strip any default-database path from the URI. If the URI is
  // `mongodb://user:pass@host/testdb?authSource=admin`, mongorestore treats
  // `/testdb` as "I want to restore INTO a single database called testdb",
  // and then refuses to honour --dir's multi-db dump layout — it logs
  // "don't know what to do with subdirectory `dump/<db>`, skipping...".
  // We want mongorestore to operate on the dump root only, so the connection
  // string must NOT pin a default database.
  const cleanUri = stripMongoUriPath(uri);
  const args = ['--uri', cleanUri, '--dir', dumpDir, '--gzip', '--drop'];
  const { stdout, stderr } = await execFileAsync('mongorestore', args, {
    env: { ...process.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  return [stderr, stdout].filter(Boolean).join('\n') || 'mongorestore completed successfully';
}

/**
 * Remove the `/dbname` path component from a Mongo URI, preserving auth,
 * host(s), options, and the `mongodb+srv://` scheme. Examples:
 *   mongodb://u:p@host:27017/testdb           → mongodb://u:p@host:27017/
 *   mongodb://u:p@host/testdb?authSource=admin → mongodb://u:p@host/?authSource=admin
 *   mongodb+srv://u:p@cluster.x/db?w=majority → mongodb+srv://u:p@cluster.x/?w=majority
 */
function stripMongoUriPath(uri: string): string {
  // mongodb URIs are awkward for Node's URL class with multiple hosts, so do
  // it by regex. We split into "scheme://authority", "/db", and "?opts".
  return uri.replace(
    /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/,
    '$1/$2',
  );
}

async function runPostgresRestore(uri: string, extractDir: string): Promise<string> {
  // pg_dump produced `dumpDir/pg.dump` inside `extractDir/dump/`.
  const dumpFile = path.join(extractDir, 'dump', 'pg.dump');
  const args = [
    '--dbname', uri,
    '--clean',                 // drop existing objects before restoring
    '--if-exists',             // tolerate missing objects on the drop step
    '--no-owner', '--no-acl',  // restore as the connection user; ignore GRANT/REVOKE
    '--exit-on-error',
    dumpFile,
  ];
  const { stdout, stderr } = await execFileAsync('pg_restore', args, {
    env: { ...process.env },
    maxBuffer: 50 * 1024 * 1024,
  });
  return [stderr, stdout].filter(Boolean).join('\n') || 'pg_restore completed successfully';
}

async function runMysqlRestore(uri: string, extractDir: string): Promise<string> {
  // mysqldump produced `dumpDir/mysql.sql` inside `extractDir/dump/`.
  const sqlFile = path.join(extractDir, 'dump', 'mysql.sql');
  const u = new URL(uri);
  const host = u.hostname;
  const port = u.port || '3306';
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const targetDb = decodeURIComponent(u.pathname.replace(/^\//, ''));

  // The dump may contain its own `CREATE DATABASE` + `USE` statements (we used
  // --databases when dumping). We still pass --database if the URI carries
  // one, in case the SQL doesn't switch context.
  const args = [
    '-h', host, '-P', port, '-u', user,
    // Force TCP — see comment in backup.job.ts dumpMysql(). When --host=localhost
    // the mysql client falls back to a Unix socket (/tmp/mysql.sock) and ignores
    // -P, which fails when MySQL runs in Docker.
    '--protocol=TCP',
    '--force', // continue on individual errors so partial restores still log usefully
  ];
  if (targetDb) args.push('--database', targetDb);

  // Stream the file into mysql's stdin. We avoid `execFile` here because we
  // need an stdio pipe — use spawn + manual collection.
  const { spawn } = await import('node:child_process');
  return new Promise<string>((resolve, reject) => {
    const proc = spawn('mysql', args, {
      env: { ...process.env, MYSQL_PWD: password },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '', stderrBuf = '';
    proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const log = [stderrBuf, stdoutBuf].filter(Boolean).join('\n') || 'mysql import completed';
      if (code === 0) resolve(log);
      else reject(new Error(`mysql exited with code ${code}: ${log}`));
    });
    const fileStream = createReadStream(sqlFile);
    fileStream.pipe(proc.stdin);
    fileStream.on('error', reject);
  });
}
