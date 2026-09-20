import { S3Client } from '@aws-sdk/client-s3';
import { decrypt } from '../crypto/encrypt.js';

export function getS3Client(encryptedCredentials: string, region: string): S3Client {
  const creds = JSON.parse(decrypt(encryptedCredentials)) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    roleArn?: string;
  };

  if (creds.accessKeyId && creds.secretAccessKey) {
    return new S3Client({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });
  }

  // IAM role assumed via environment (EC2/ECS)
  return new S3Client({ region });
}
