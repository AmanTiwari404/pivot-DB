import { prisma } from '../lib/prisma.js';
import { exportQueue } from '../lib/queue.js';

export async function createExportJob(data: {
  connectionId: string;
  profileId: string;
  database: string;
  collection?: string;
  query: unknown;
  isPipeline: boolean;
  format: 'csv' | 'json';
  options: Record<string, unknown>;
  destination?: string;
}) {
  const job = await prisma.exportJob.create({ data: { ...data, collection: data.collection ?? null, query: data.query as object, options: data.options as object } });
  await exportQueue.add('export', { jobId: job.id });
  return job;
}

export async function listExportJobs(connectionId: string) {
  return prisma.exportJob.findMany({ where: { connectionId }, orderBy: { createdAt: 'desc' } });
}

export async function getExportJob(jobId: string) {
  return prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } });
}

export async function deleteExportJob(jobId: string) {
  await prisma.exportJob.delete({ where: { id: jobId } });
}
