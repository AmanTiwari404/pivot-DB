import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decrypt } from '../crypto/encrypt.js';
import { prisma } from '../lib/prisma.js';
import { getFreshClient } from '../lib/mongo.js';

export interface MigrationOptions {
  dropDestination: boolean;
  dropAllDestination: boolean; // wipe ENTIRE destination (all DBs) even on scoped migrations
  preserveUsers: boolean;
  oplog: boolean;
  gzip: boolean;
  numParallelCollections: number;
}

export async function runMigration(
  jobId: string,
  onProgress: (phase: string, line: string) => void,
): Promise<void> {
  const job = await prisma.migrationJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { source: true, destination: true },
  });

  const sourceUri = decrypt(job.source.encryptedUri);
  const destUri   = decrypt(job.destination.encryptedUri);
  const options   = job.options as unknown as MigrationOptions;
  const scope     = job.scope as { all?: boolean; databases?: string[] };

  const tempDir = await mkdtemp(path.join(tmpdir(), `mongo-migrate-${jobId}-`));

  await prisma.migrationJob.update({
    where: { id: jobId },
    data: { tempDirPath: tempDir, status: 'running' },
  });

  const run = await prisma.migrationRun.create({
    data: { jobId, status: 'running', phase: 'dump' },
  });

  const logLines: string[] = [];

  const addLog = async (phase: string, line: string) => {
    logLines.push(`[${phase}] ${line}`);
    if (logLines.length > 100) logLines.shift();
    onProgress(phase, line);
    await prisma.migrationRun.update({
      where: { id: run.id },
      data: { phase, logLines: logLines.slice(-100) },
    });
  };

  // Auto-detect Atlas (SRV) URIs — mongodump/mongorestore on macOS can't verify
  // Atlas certificates with Go's TLS stack, so we skip TLS verification automatically.
  const sourceTlsInsecure = sourceUri.startsWith('mongodb+srv://');
  const destTlsInsecure   = destUri.startsWith('mongodb+srv://');

  try {
    // ── PRE-DROP: drop destination databases via driver before mongorestore ──────
    // mongorestore --drop only drops collections present in the dump file.
    // It does NOT remove other existing collections/databases in the destination.
    // To get a truly clean destination, we drop each in-scope database ourselves
    // using the MongoDB driver before the dump even starts.
    //
    // dropAllDestination = true  → wipe EVERY non-system DB on destination (even if migration is scoped)
    // dropDestination    = true  → wipe only the databases that are in scope
    if (options.dropDestination || options.dropAllDestination) {
      const dropAll = options.dropAllDestination;
      await addLog('dump', dropAll
        ? 'Drop All Destination is ON — wiping ALL databases on destination before migration…'
        : 'Drop Destination is ON — dropping destination databases before migration…'
      );
      const destClient = await getFreshClient(destUri);
      try {
        const systemDbs = new Set(['admin', 'local', 'config']);

        if (dropAll || scope.all) {
          // Drop ALL non-system databases on destination
          const dbList = (await destClient.db('admin').command({ listDatabases: 1 }))
            .databases as Array<{ name: string }>;
          for (const { name } of dbList) {
            if (systemDbs.has(name)) continue;
            await destClient.db(name).dropDatabase();
            await addLog('dump', `Dropped destination database: ${name}`);
          }
        } else if (scope.databases?.length) {
          // Drop only the databases in scope
          for (const dbName of scope.databases) {
            if (systemDbs.has(dbName)) continue;
            await destClient.db(dbName).dropDatabase();
            await addLog('dump', `Dropped destination database: ${dbName}`);
          }
        }
      } finally {
        await destClient.close();
      }
      await addLog('dump', 'Destination databases dropped. Starting dump…');
    }

    await addLog('dump', `Starting mongodump to ${tempDir}`);

    const dumpArgs = [
      `--uri=${sourceUri}`,
      `--out=${tempDir}`,
      `--numParallelCollections=${options.numParallelCollections ?? 4}`,
      '--readPreference=secondaryPreferred',
      ...(sourceTlsInsecure ? ['--tlsInsecure'] : []),
      ...(options.gzip ? ['--gzip'] : []),
      // --oplog only works on replica sets AND only when dumping ALL databases (no --db flag)
      // Skip it for scoped dumps — it causes a prelude.json.gz that confuses mongorestore
      ...(options.oplog && scope.all ? ['--oplog'] : []),
    ];

    if (!scope.all && scope.databases?.length) {
      for (const db of scope.databases) {
        await runCommand('mongodump', [...dumpArgs, `--db=${db}`], (line) => addLog('dump', line));
        await addLog('dump', `Dumped database: ${db}`);
      }
    } else {
      await runCommand('mongodump', dumpArgs, (line) => addLog('dump', line));
    }

    await addLog('dump', 'Dump complete');

    await addLog('restore', `Starting mongorestore from ${tempDir}`);

    const restoreArgs = [
      `--uri=${destUri}`,
      `--dir=${tempDir}`,
      `--numParallelCollections=${options.numParallelCollections ?? 4}`,
      // Databases were already dropped via the driver above when dropDestination=true,
      // so we don't need --drop here. Omitting it also avoids the --preserveUUID
      // privilege issue on Atlas M0/M2/M5.
      ...(destTlsInsecure ? ['--tlsInsecure'] : []),
      ...(options.gzip ? ['--gzip'] : []),
      // --oplogReplay only makes sense if --oplog was used during dump
      ...(options.oplog && scope.all ? ['--oplogReplay'] : []),
    ];

    await runCommand('mongorestore', restoreArgs, (line) => addLog('restore', line));
    await addLog('restore', 'Restore complete');

    await addLog('cleanup', 'Removing temp files');
    await rm(tempDir, { recursive: true, force: true });
    await addLog('cleanup', 'Temp directory removed');

    await prisma.migrationRun.update({
      where: { id: run.id },
      data: { status: 'done', finishedAt: new Date(), phase: 'done', logLines },
    });

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: 'done', tempDirPath: null },
    });
  } catch (err: unknown) {
    try { await rm(tempDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    const message = err instanceof Error ? err.message : String(err);
    await prisma.migrationRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorReport: { message },
        logLines,
      },
    });
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: 'failed', tempDirPath: null },
    });
    throw err;
  }
}

function runCommand(
  cmd: 'mongodump' | 'mongorestore',
  args: string[],
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const handleData = async (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        await onLine(line.trim());
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

export async function cleanupStaleMigrationDirs(): Promise<void> {
  const stale = await prisma.migrationJob.findMany({
    where: { tempDirPath: { not: null }, status: { not: 'running' } },
  });
  for (const job of stale) {
    if (job.tempDirPath) {
      await rm(job.tempDirPath, { recursive: true, force: true }).catch(() => {});
      await prisma.migrationJob.update({ where: { id: job.id }, data: { tempDirPath: null } });
    }
  }
}
