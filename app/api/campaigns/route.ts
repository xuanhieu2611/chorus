import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { emit } from '@/lib/events';
import { env } from '@/lib/env';
import { campaignUploadDir, pendingUploadDir, toStorageRelative } from '@/lib/media/paths';

/**
 * Create a campaign and enqueue it.
 *
 * This route never runs the agent graph. It writes a row with `status='queued'`
 * and returns; the worker claims it with `for update skip locked` and runs the
 * campaign to completion or to a human gate. That split is why a 20 minute
 * campaign is not bounded by any HTTP request timeout.
 */
export const runtime = 'nodejs';

const CreateCampaign = z.object({
  upload_token: z.uuid(),
  goal: z.string().trim().min(10, 'Describe the growth objective in a sentence or more.'),
  title: z.string().trim().min(1).max(200).optional(),
  audience: z.string().trim().max(500).optional(),
  brand_voice: z.string().trim().max(500).optional(),
  platforms: z.array(z.enum(['tiktok', 'x', 'linkedin'])).min(1).optional(),
  // The effective cap is checked against env.maxAssets below because it can be
  // lowered by MAX_ASSETS at runtime, while the MVP ceiling stays at six.
  max_assets: z.number().int().min(1).optional(),
  /** Aggregate allowance shared by every short-video asset in the campaign. */
  max_video_seconds: z
    .number({ error: 'Maximum total video seconds must be a number.' })
    .int('Maximum total video seconds must be a whole number.')
    .min(15, 'Maximum total video seconds must be at least 15 seconds.')
    .max(600, 'Maximum total video seconds must be at most 600 seconds.')
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = CreateCampaign.safeParse(body);
  if (!parsed.success) {
    const issue =
      parsed.error.issues.find((item) => item.path[0] === 'max_video_seconds') ??
      parsed.error.issues[0];
    return Response.json(
      {
        error: issue?.message ?? 'Invalid campaign.',
        issues: z.treeifyError(parsed.error),
      },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (input.max_assets !== undefined && input.max_assets > env.maxAssets) {
    return Response.json(
      { error: `Maximum assets is ${env.maxAssets} in the MVP.` },
      { status: 400 },
    );
  }

  const pendingDir = pendingUploadDir(input.upload_token);
  const sourceName = await findSourceFile(pendingDir);
  if (!sourceName) {
    return Response.json(
      { error: 'That upload is not on disk. Upload the file again.' },
      { status: 409 },
    );
  }

  // Inserted as 'ingesting', not 'queued'. 'queued' is the only signal the
  // worker's claim query looks at, and the row has no `source_path` until the
  // upload directory has been renamed below. Enqueueing first would let a worker
  // claim a campaign with no source and fail it instantly.
  const { data: campaign, error } = await db()
    .from('campaigns')
    .insert({
      goal: input.goal,
      title: input.title ?? null,
      audience: input.audience ?? null,
      brand_voice: input.brand_voice ?? null,
      ...(input.platforms ? { platforms: input.platforms } : {}),
      ...(input.max_assets ? { max_assets: input.max_assets } : {}),
      ...(input.max_video_seconds !== undefined ? { max_video_seconds: input.max_video_seconds } : {}),
      credit_budget: env.defaultCreditBudget,
      status: 'ingesting',
    })
    .select()
    .single();

  if (error || !campaign) {
    return Response.json({ error: error?.message ?? 'Insert returned no row.' }, { status: 500 });
  }

  const uploadDir = campaignUploadDir(campaign.id);
  try {
    await rename(pendingDir, uploadDir);
  } catch (renameError) {
    // Nothing has been queued yet, so deleting the row leaves no orphan a worker
    // could pick up. The uploaded file is left alone; it is the user's data.
    await db().from('campaigns').delete().eq('id', campaign.id);
    const message = renameError instanceof Error ? renameError.message : String(renameError);
    return Response.json({ error: `Could not move the upload: ${message}` }, { status: 500 });
  }

  // The ignore comment is only about build-time file tracing: Turbopack sees a
  // `join` on non-literal parts and conservatively traces the entire project
  // into the server bundle. STORAGE_DIR is runtime configuration and nothing
  // here is read at build time.
  const sourcePath = toStorageRelative(join(/* turbopackIgnore: true */ uploadDir, sourceName));

  const { error: enqueueError } = await db()
    .from('campaigns')
    .update({ source_path: sourcePath, status: 'queued', updated_at: new Date().toISOString() })
    .eq('id', campaign.id);

  if (enqueueError) {
    await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    await db().from('campaigns').delete().eq('id', campaign.id);
    return Response.json({ error: enqueueError.message }, { status: 500 });
  }

  await emit({
    campaignId: campaign.id,
    agent: 'system',
    level: 'info',
    message: `Campaign queued: ${input.goal}`,
    data: { source: sourceName },
  });

  return Response.json({ id: campaign.id }, { status: 201 });
}

async function findSourceFile(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    return entries.find((name) => name.startsWith('source.')) ?? null;
  } catch {
    return null;
  }
}
