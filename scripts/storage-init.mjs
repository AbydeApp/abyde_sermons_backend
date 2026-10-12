// Creates the local development bucket (private) with a CORS rule allowing direct browser uploads.
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

try {
  process.loadEnvFile();
} catch {}

const client = new S3Client({
  region: process.env.STORAGE_REGION ?? 'auto',
  endpoint: process.env.STORAGE_ENDPOINT,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  },
});
const Bucket = process.env.STORAGE_BUCKET ?? 'abyde-sermon-dev';
const origins = (process.env.APP_CORS_ORIGINS ?? 'http://localhost:3001')
  .split(',')
  .map((o) => o.trim());

try {
  await client.send(new CreateBucketCommand({ Bucket }));
  console.log(`Created bucket ${Bucket}`);
} catch (error) {
  if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name))
    throw error;
  console.log(`Bucket ${Bucket} already exists`);
}
await client
  .send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['PUT', 'GET'],
            AllowedHeaders: ['*'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  )
  .then(() => console.log('Applied CORS rule'))
  .catch((error) =>
    console.warn(
      `CORS rule not applied (${error.name}); configure it in your storage provider`,
    ),
  );
