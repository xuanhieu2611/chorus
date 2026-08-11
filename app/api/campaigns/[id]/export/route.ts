import { ZipArchive } from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { db } from '@/lib/db/client';
import {
  buildCampaignExportManifest,
  exportAssetProblems,
  exportVideoBudgetProblem,
  safeFilename,
  selectExportAssets,
} from '@/lib/export';
import { storageRoot } from '@/lib/media/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stream the final package. Local media is handed to archiver as file paths, so
 * a 20 MB clip never becomes a Buffer and a campaign never becomes one giant
 * in-memory object.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const [campaignResult, assetsResult, reviewResult] = await Promise.all([
    db().from('campaigns').select('*').eq('id', id).maybeSingle(),
    db().from('assets').select('*').eq('campaign_id', id).order('created_at', { ascending: true }),
    db()
      .from('campaign_reviews')
      .select('*')
      .eq('campaign_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (campaignResult.error) return jsonError(campaignResult.error.message, 500);
  if (!campaignResult.data) return jsonError('Campaign not found.', 404);
  if (assetsResult.error) return jsonError(assetsResult.error.message, 500);
  if (reviewResult.error) return jsonError(reviewResult.error.message, 500);

  if (campaignResult.data.status !== 'complete') {
    return jsonError(
      'The final package is available after final approval and successful packaging. Keep this page open while the worker finishes.',
      409,
    );
  }

  const selectedAssets = selectExportAssets(assetsResult.data ?? []);
  if (selectedAssets.length === 0) {
    return jsonError('There are no Critic-passed assets to export. Review the campaign for recovery guidance.', 409);
  }

  const problems = selectedAssets.flatMap((asset) =>
    exportAssetProblems(asset).map((problem) => `${asset.plan_key}: ${problem}`),
  );
  if (problems.length > 0) return jsonError(`The final package is incomplete: ${problems.join('; ')}`, 422);

  const videoBudgetProblem = exportVideoBudgetProblem(campaignResult.data, selectedAssets);
  if (videoBudgetProblem) return jsonError(`The final package exceeds its campaign-wide video budget: ${videoBudgetProblem}`, 422);

  const manifest = buildCampaignExportManifest({
    campaign: campaignResult.data,
    assets: selectedAssets,
    campaignReview: reviewResult.data,
  });
  const mediaFiles: Array<{ name: string; path: string }> = [];

  try {
    for (const entry of manifest.assets) {
      if (!entry.mediaPath) continue;
      const path = resolveExportMediaPath(entry.mediaPath);
      const file = await stat(path);
      if (!file.isFile()) throw new Error(`${entry.planKey} media path is not a file.`);
      mediaFiles.push({ name: entry.filename, path });
    }
  } catch (error) {
    return jsonError(
      `A rendered clip is not available locally. Re-run the campaign or restore its storage directory. ${error instanceof Error ? error.message : String(error)}`,
      422,
    );
  }

  const output = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (error: Error) => output.destroy(error));
  archive.on('warning', (warning: Error & { code?: string }) => {
    if (warning.code !== 'ENOENT') output.destroy(warning);
  });
  archive.pipe(output);

  void (async () => {
    try {
      archive.append(manifest.campaignMarkdown, { name: 'campaign.md' });
      for (const entry of manifest.assets) {
        if (entry.mediaPath) continue;
        archive.append(entry.markdown, { name: entry.filename });
      }
      for (const media of mediaFiles) archive.file(media.path, { name: media.name });
      await archive.finalize();
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  const filename = `campaign-${safeFilename(campaignResult.data.title ?? id)}.zip`;
  return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

function resolveExportMediaPath(mediaPath: string): string {
  const root = resolve(storageRoot());
  const candidate = resolve(root, mediaPath);
  const outsideRoot = relative(root, candidate).split(sep).includes('..');
  if (outsideRoot || (isAbsolute(mediaPath) && !candidate.startsWith(`${root}${sep}`))) {
    throw new Error('media path escapes STORAGE_DIR.');
  }
  return candidate;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
