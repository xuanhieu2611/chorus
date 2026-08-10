import { isAbsolute, join, resolve } from 'node:path';
import { env } from '@/lib/env';

/**
 * Where media lives on disk, in one place.
 *
 * Supabase's free tier caps a single upload at 50 MB and a 90 minute recording
 * is 1 to 3 GB, so source media never leaves this machine. Only rendered clips
 * (5 to 20 MB) go to Supabase Storage, in Phase 5. That split is the one place
 * the "local only" and "Supabase" decisions interact, and it is intentional.
 */

/** Extensions the upload route accepts. Container, not codec: `probe()` has the
 * final word on whether a file actually holds a video stream. */
export const ACCEPTED_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.mp3',
  '.m4a',
  '.wav',
  '.aac',
  '.flac',
  '.ogg',
] as const;

export function storageRoot(): string {
  return resolve(env.storageDir);
}

/** Uploads that have no campaign row yet. The file arrives first, the campaign
 * is created from the form on submit, and the directory is then renamed. */
export function pendingUploadDir(token: string): string {
  return join(storageRoot(), 'uploads', '_pending', token);
}

export function campaignUploadDir(campaignId: string): string {
  return join(storageRoot(), 'uploads', campaignId);
}

/** Scratch space: extracted audio, transcription chunks, draft cuts, renders.
 * Everything here is reproducible from the source file. */
export function campaignWorkDir(campaignId: string): string {
  return join(storageRoot(), 'work', campaignId);
}

/** The 16 kHz mono MP3 that goes to Groq. */
export function campaignAudioPath(campaignId: string): string {
  return join(campaignWorkDir(campaignId), 'audio.mp3');
}

/** `campaigns.source_path` is stored relative to `STORAGE_DIR` so the row stays
 * valid if the directory moves. */
export function resolveSourcePath(sourcePath: string): string {
  return isAbsolute(sourcePath) ? sourcePath : join(storageRoot(), sourcePath);
}

export function toStorageRelative(absolutePath: string): string {
  const root = storageRoot();
  return absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : absolutePath;
}
