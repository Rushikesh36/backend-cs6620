import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EXIT, ScanError, type Env } from "./job.js";

/**
 * S3 client for the scanner. S3_ENDPOINT is only for running the images on a laptop against a
 * local S3 stand-in (docs/scanners.md); in AWS it is unset and the S3 gateway endpoint is used.
 */
export function scannerS3Client(env: Env): S3Client {
  const endpoint = env.S3_ENDPOINT?.trim();
  return endpoint ? new S3Client({ endpoint, forcePathStyle: true }) : new S3Client({});
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : "");
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Fails the stream once more than maxBytes have passed, whatever the object claimed to be. */
function byteLimit(maxBytes: number, message: string): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) callback(new ScanError(message, EXIT.INPUT));
      else callback(null, chunk);
    },
  });
}

/** Downloads one object to a file. Missing or too large is the user's input; anything else is S3. */
export async function downloadToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  file: string,
  maxBytes: number,
): Promise<void> {
  const tooLarge = `The upload is larger than ${String(maxBytes)} bytes.`;
  let body: unknown;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if ((out.ContentLength ?? 0) > maxBytes) throw new ScanError(tooLarge, EXIT.INPUT);
    body = out.Body;
  } catch (err) {
    if (err instanceof ScanError) throw err;
    if (errorName(err) === "NoSuchKey") {
      throw new ScanError("The uploaded zip was not found.", EXIT.INPUT);
    }
    throw new ScanError(`Could not download the upload: ${errorText(err)}`, EXIT.STORAGE);
  }
  if (!(body instanceof Readable)) {
    throw new ScanError("Could not download the upload: empty response.", EXIT.STORAGE);
  }
  try {
    await pipeline(body, byteLimit(maxBytes, tooLarge), createWriteStream(file));
  } catch (err) {
    if (err instanceof ScanError) throw err;
    throw new ScanError(`Could not download the upload: ${errorText(err)}`, EXIT.STORAGE);
  }
}

/** Uploads the finished report where the processor (Task 19) looks for it. */
export async function uploadReport(
  s3: S3Client,
  bucket: string,
  key: string,
  report: unknown,
): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(report),
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    throw new ScanError(`Could not upload the report: ${errorText(err)}`, EXIT.STORAGE);
  }
}
