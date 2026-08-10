import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ACCEPTED_EXTENSIONS, pendingUploadDir } from '@/lib/media/paths';

/**
 * Streams an upload to local disk.
 *
 * The body is the raw file, not multipart. `request.formData()` buffers the
 * whole thing in memory, and a 90 minute recording is 1 to 3 GB, so the browser
 * sends the `File` as the body directly and puts its name in a header. That
 * keeps this route at constant memory regardless of file size.
 *
 * The file arrives before the campaign row exists, so it lands in a pending
 * directory keyed by an opaque token. `POST /api/campaigns` renames that
 * directory to the campaign id, which on one filesystem is instant and cannot
 * half-copy a 3 GB file.
 */
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rawFilename = request.headers.get('x-filename');
  if (!rawFilename) {
    return Response.json({ error: 'Missing x-filename header.' }, { status: 400 });
  }
  // Headers are latin-1, so the client percent-encodes anything outside it. A
  // name that is not valid encoding is still a usable display string.
  const filename = safeDecode(rawFilename);
  if (!request.body) {
    return Response.json({ error: 'Request had no body.' }, { status: 400 });
  }

  const extension = extname(filename).toLowerCase();
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return Response.json(
      {
        error: `Unsupported file type "${extension || filename}". Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
      },
      { status: 415 },
    );
  }

  const token = randomUUID();
  const dir = pendingUploadDir(token);
  // The name on disk is ours, never the user's. `filename` is display text that
  // came from a browser and never becomes a path component.
  const destination = join(dir, `source${extension}`);

  await mkdir(dir, { recursive: true });

  try {
    await pipeline(
      Readable.fromWeb(request.body as WebReadableStream<Uint8Array>),
      createWriteStream(destination),
    );
  } catch (error) {
    // A browser tab closed mid-upload leaves a truncated file that would probe
    // as a valid short video, so the partial write does not survive the failure.
    await rm(dir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Upload failed: ${message}` }, { status: 500 });
  }

  const { size } = await stat(destination);
  if (size === 0) {
    await rm(dir, { recursive: true, force: true });
    return Response.json({ error: 'Uploaded file was empty.' }, { status: 400 });
  }

  return Response.json({ upload_token: token, filename, bytes: size, extension });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
