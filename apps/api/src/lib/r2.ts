import { S3Client } from '@aws-sdk/client-s3';
import { decrypt } from '../crypto/encrypt.js';

export function getR2Client(accountId: string, encryptedAccessKey: string, encryptedSecretKey: string): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: decrypt(encryptedAccessKey),
      secretAccessKey: decrypt(encryptedSecretKey),
    },
  });
}
