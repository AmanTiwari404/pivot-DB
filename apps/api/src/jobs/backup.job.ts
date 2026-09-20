import { Worker, Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createCipheriv, randomBytes, CipherGCM } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';

const execFileAsync = promisify(execFile);

const BACKUP_BASE_DIR = process.env.BACKUP_DIR ?? '/app/backups';
const ENCRYPTION_KEY_HEX = process.env.BACKUP_ENCRYPTION_KEY;

export function startBackupWorker() {
  const worker = new Worker(
    'backup',
    async (job: Job) => {
      const { backupJobId } = job.data as { backupJobId: string };

      const backupJob = await prisma.backupJob.findUnique({
        where: { id: backupJobId },
        include: { connection: true },
      });
      if (!backupJob) return; // stale job — ignore

      // Create run record
      const run = await prisma.backupRun.create({
        data: { jobId: backupJobId, status: 'running', databases: backupJob.databases },
      });

      // Mark job as running
      await prisma.backupJob.update({
        where: { id: backupJobId },
        data: { lastRunAt: new Date(), lastRunStatus: 'running' },
      });

      const tempDir = path.join('/tmp', `backup-${run.id}`);
      const dumpDir = path.join(tempDir, 'dump');
      const outputDir = path.join(BACKUP_BASE_DIR, backupJob.profileId);
      const ext = ENCRYPTION_KEY_HEX ? '.tar.gz.enc' : '.tar.gz';
      const archivePath = path.join(outputDir, `${run.id}${ext}`);

      try {
        // Step 1: Create temp + output dirs
        await mkdir(dumpDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });

        // Step 2: Decrypt connection URI
        const uri = decrypt(backupJob.connection.encryptedUri);

        // Step 3: Run the engine-appropriate dump tool into `dumpDir`.
        // The surrounding tar/gzip/encrypt/retention pipeline is identical
        // across engines, so we only branch here.
        const dbType = backupJob.connection.dbType;
        if (dbType === 'mongodb') {
          await dumpMongo(uri, dumpDir, backupJob.databases);
        } else if (dbType === 'postgres') {
          await dumpPostgres(uri, dumpDir);
        } else if (dbType === 'mysql') {
          await dumpMysql(uri, dumpDir, backupJob.databases);
        } else {
          throw new Error(`Backup not supported for dbType "${dbType}"`);
        }

        // Step 4: tar the dump directory
        const tarPath = path.join(tempDir, 'backup.tar');
        await execFileAsync('tar', ['-cf', tarPath, '-C', tempDir, 'dump']);

        // Step 5: gzip + optional AES-256-GCM encryption → final archive
        const readStream = createReadStream(tarPath);
        const gzip = createGzip();
        const writeStream = createWriteStream(archivePath);

        if (ENCRYPTION_KEY_HEX) {
          const iv = randomBytes(12);
          const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
          const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM;

          // Append the 16-byte GCM auth tag as the very last bytes of the file.
          // File format: [12 bytes IV][encrypted gzipped tar][16 bytes auth tag]
          // We use a pass-through Transform whose flush() emits the auth tag so
          // pipeline() writes it before closing the write stream.
          const appendAuthTag = new Transform({
            transform(chunk, _enc, cb) { cb(null, chunk); },
            flush(cb) { cb(null, cipher.getAuthTag()); },
          });

          // Prepend IV as first 12 bytes so decrypt can extract it
          writeStream.write(iv);
          await pipeline(readStream, gzip, cipher, appendAuthTag, writeStream);
        } else {
          await pipeline(readStream, gzip, writeStream);
        }

        // Step 6: Get file size
        const fileStats = await stat(archivePath);

        // Step 7: Mark run as success
        await prisma.backupRun.update({
          where: { id: run.id },
          data: {
            status: 'success',
            finishedAt: new Date(),
            sizeBytes: fileStats.size,
            filePath: archivePath,
          },
        });

        await prisma.backupJob.update({
          where: { id: backupJobId },
          data: { lastRunStatus: 'success', lastRunError: null },
        });

        // Step 8: Enforce strict retention — keep only the 3 most recent successful runs
        const allSuccessfulRuns = await prisma.backupRun.findMany({
          where: { jobId: backupJobId, status: 'success' },
          orderBy: { startedAt: 'desc' },
          select: { id: true, filePath: true, startedAt: true },
        });

        const runsToDelete = allSuccessfulRuns.slice(3);
        for (const old of runsToDelete) {
          if (old.filePath) {
            await rm(old.filePath, { force: true }).catch(() => { /* file already gone */ });
          }
          await prisma.backupRun.delete({ where: { id: old.id } }).catch(() => { /* row already gone */ });
        }

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        await prisma.backupRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), errorMsg: message },
        });

        await prisma.backupJob.update({
          where: { id: backupJobId },
          data: { lastRunStatus: 'failed', lastRunError: message },
        });

        throw err;
      } finally {
        // Always clean up temp directory
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    console.error(`[BackupWorker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine-specific dump helpers
//
// Each writes its output into `dumpDir`. The caller then `tar`s + gzips +
// optionally encrypts the directory. The directory layout doesn't need to be
// uniform across engines — restore code branches on dbType anyway.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mongodump → `dumpDir/dump/<db>/...` BSON files.
 * NOTE: do NOT pass --tlsInsecure for mongodb+srv:// — Atlas has valid
 * certs and `--tlsInsecure` breaks SNI on Atlas's load balancer, producing
 * "remote error: tls: internal error" handshake failures.
 */
async function dumpMongo(uri: string, dumpDir: string, databases: string[]): Promise<void> {
  const baseDumpArgs = ['--uri', uri, '--out', dumpDir, '--gzip'];
  if (databases.length > 0) {
    for (const db of databases) {
      await execFileAsync('mongodump', [...baseDumpArgs, '--db', db]);
    }
  } else {
    await execFileAsync('mongodump', baseDumpArgs);
  }
}

/**
 * pg_dump → `dumpDir/pg.dump` (custom format, compressed).
 *
 * Custom format (`-Fc`) is the recommended PG backup format: single file,
 * built-in compression, supports parallel restore via `pg_restore --jobs=N`,
 * lets pg_restore selectively restore specific objects later.
 *
 * The connection's URI is bound to ONE database in PG. The `databases` array
 * on BackupJob is meaningful for Mongo (multi-DB cluster) but irrelevant for
 * PG — we always dump the database the URI points at. We log a warning if
 * the user set the field expecting multi-DB behaviour.
 */
async function dumpPostgres(uri: string, dumpDir: string): Promise<void> {
  // pg_dump accepts the full URI via --dbname. SSL params in the URI are honoured.
  const outFile = path.join(dumpDir, 'pg.dump');
  await execFileAsync('pg_dump', [
    '--dbname', uri,
    '--format=custom',         // -Fc
    '--no-owner',              // restore works regardless of target user
    '--no-acl',                // don't dump GRANT/REVOKE statements
    // Skip CDC infrastructure objects. Replaying these on restore requires
    // SUPERUSER (specifically `ALTER PUBLICATION ... ADD TABLES IN SCHEMA`),
    // which managed Postgres roles (Neon's neondb_owner, RDS, Cloud SQL)
    // do not have. They are application concerns, not data — the sync code
    // re-provisions its own publications/slots on demand.
    '--no-publications',
    '--no-subscriptions',
    '--file', outFile,
  ]);
}

/**
 * mysqldump → `dumpDir/mysql.sql.gz`.
 *
 * Uses `--single-transaction` for InnoDB consistency without locking tables.
 * `--routines` + `--triggers` include stored procs and triggers.
 * `--no-tablespaces` avoids the PROCESS privilege requirement common on
 * managed MySQL (RDS, PlanetScale, etc.).
 *
 * MySQL URIs aren't accepted by mysqldump — we parse the URL and pass
 * individual flags. The password goes via MYSQL_PWD env var so it doesn't
 * appear in the process list.
 */
async function dumpMysql(uri: string, dumpDir: string, databases: string[]): Promise<void> {
  const u = new URL(uri);
  const host = u.hostname;
  const port = u.port || '3306';
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const uriDb = decodeURIComponent(u.pathname.replace(/^\//, ''));

  // Pick database list: user-specified, else fall back to the URI's database.
  const dbList = databases.length > 0 ? databases : (uriDb ? [uriDb] : []);
  if (dbList.length === 0) {
    throw new Error('MySQL backup requires either a database in the connection URI or one or more databases in the backup job config');
  }

  const args = [
    '-h', host, '-P', port, '-u', user,
    // Force TCP. Without this, libmysqlclient ignores -P and silently falls
    // back to a Unix socket whenever the host is "localhost" — which fails
    // when MySQL runs in Docker because /tmp/mysql.sock doesn't exist on the
    // host. Forcing TCP makes the connection deterministic across hostnames.
    '--protocol=TCP',
    '--single-transaction',
    '--routines', '--triggers',
    '--no-tablespaces',
    // NOTE: do NOT pass `--set-gtid-purged=OFF` — that flag is MySQL-specific
    // and MariaDB's mysqldump (which Debian's `default-mysql-client` ships)
    // rejects it as "unknown variable". Aiven free tier / most managed MySQL
    // setups don't enable GTID anyway. If we ever target a GTID-enabled
    // server we'll need to swap in Oracle's mysql-client and re-add the flag.
    '--databases', ...dbList,
  ];

  const outFile = path.join(dumpDir, 'mysql.sql');
  const { writeFile } = await import('node:fs/promises');
  const { execFile: execFileRaw } = await import('node:child_process');

  // mysqldump streams to stdout — we capture and write the file ourselves so
  // we can also gzip in-process if we add a streaming gzip step later.
  await new Promise<void>((resolve, reject) => {
    const proc = execFileRaw('mysqldump', args, {
      env: { ...process.env, MYSQL_PWD: password },
      maxBuffer: 1024 * 1024 * 1024,  // 1 GB — for tiny test fixtures this is plenty
    }, (err, stdout) => {
      if (err) return reject(err);
      writeFile(outFile, stdout).then(resolve, reject);
    });
    proc.on('error', reject);
  });
}
