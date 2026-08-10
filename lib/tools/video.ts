import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/db/client';
import {
  cutDraft,
  detectSilences,
  probe,
  renderVertical,
  sampleFrames,
  type SilenceRange,
} from '@/lib/media/ffmpeg';
import { assetWorkDir, resolveSourcePath, toStorageRelative } from '@/lib/media/paths';
import { generateAssSubtitles } from '@/lib/media/subtitles';
import type { Word } from '@/lib/media/transcribe';

export interface CampaignMedia {
  sourcePath: string;
  hasVideoStream: boolean;
}

export async function getCampaignMedia(campaignId: string): Promise<CampaignMedia> {
  const { data, error } = await db()
    .from('campaigns')
    .select('source_path, has_video_stream')
    .eq('id', campaignId)
    .single();
  if (error) throw new Error(`Failed to read campaign media: ${error.message}`);
  if (!data.source_path || data.has_video_stream === null) {
    throw new Error('Campaign media has not completed ingest.');
  }
  return {
    sourcePath: resolveSourcePath(data.source_path),
    hasVideoStream: data.has_video_stream,
  };
}

export async function extractVideo(
  campaignId: string,
  planKey: string,
  start: number,
  end: number,
  hasVideoStream: boolean,
): Promise<{ path: string; duration: number }> {
  const media = await getCampaignMedia(campaignId);
  if (media.hasVideoStream !== hasVideoStream) {
    throw new Error('Media branch disagrees with the probed has_video_stream fact.');
  }
  const extension = hasVideoStream ? 'mp4' : 'm4a';
  const path = join(assetWorkDir(campaignId, planKey), `draft.${extension}`);
  await cutDraft(media.sourcePath, path, start, end, hasVideoStream);
  const result = await probe(path);
  return { path, duration: result.durationSec };
}

export async function inspectRenderedVideo(
  path: string,
  options: { hasVideoStream: boolean; campaignId: string; planKey: string },
): Promise<{ silences: SilenceRange[]; frames: string[]; durationSec: number }> {
  const [result, silences] = await Promise.all([probe(path), detectSilences(path)]);
  const frames = options.hasVideoStream
    ? await sampleFrames(
        path,
        join(assetWorkDir(options.campaignId, options.planKey), 'frames'),
        result.durationSec,
        6,
      )
    : [];
  return { silences, frames, durationSec: result.durationSec };
}

export async function loadFrameImages(
  paths: string[],
): Promise<Array<{ data: Uint8Array; mediaType: string; filename: string }>> {
  return await Promise.all(
    paths.map(async (path) => ({
      data: new Uint8Array(await readFile(path)),
      mediaType: 'image/jpeg',
      filename: path.split('/').pop() ?? 'frame.jpg',
    })),
  );
}

export async function generateSubtitles(
  campaignId: string,
  planKey: string,
  words: Word[],
  start: number,
  end: number,
  hook: string,
): Promise<{ assPath: string }> {
  const assPath = join(assetWorkDir(campaignId, planKey), 'captions.ass');
  await generateAssSubtitles({ words, clipStart: start, clipEnd: end, assPath, hook });
  return { assPath };
}

export async function renderVerticalVideo(input: {
  campaignId: string;
  planKey: string;
  start: number;
  end: number;
  assPath: string;
  hasVideoStream: boolean;
}): Promise<{ path: string; duration: number }> {
  const media = await getCampaignMedia(input.campaignId);
  if (media.hasVideoStream !== input.hasVideoStream) {
    throw new Error('Render branch disagrees with the probed has_video_stream fact.');
  }
  const path = join(assetWorkDir(input.campaignId, input.planKey), 'final.mp4');
  await renderVertical({
    sourcePath: media.sourcePath,
    destPath: path,
    assPath: input.assPath,
    startSec: input.start,
    endSec: input.end,
    hasVideoStream: input.hasVideoStream,
  });
  const rendered = await probe(path);
  return { path, duration: rendered.durationSec };
}

/** Rendered clips live in one public bucket; source uploads never leave disk. */
export async function uploadAsset(
  campaignId: string,
  planKey: string,
  localPath: string,
): Promise<{ publicUrl: string }> {
  const objectPath = `${campaignId}/${planKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`;
  const body = await readFile(localPath);
  const { error } = await db().storage.from('assets').upload(objectPath, body, {
    contentType: 'video/mp4',
    cacheControl: '3600',
    upsert: true,
  });
  if (error) throw new Error(`Failed to upload rendered clip: ${error.message}`);
  const { data } = db().storage.from('assets').getPublicUrl(objectPath);
  return { publicUrl: data.publicUrl };
}

export function localMediaPath(path: string): string {
  return toStorageRelative(path);
}
