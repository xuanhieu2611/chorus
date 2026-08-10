import { db, type AssetRow } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import type { PlannedAsset } from '@/lib/agents/strategist';
import type { WrittenAsset } from '@/lib/agents/writer';
import type { ProducedClip } from '@/lib/agents/clip-producer';

export type AssetStatus =
  | 'planned'
  | 'generating'
  | 'needs_review'
  | 'revising'
  | 'passed'
  | 'rejected'
  | 'abandoned'
  | 'replaced';

/**
 * Materialize the approved plan as durable asset rows without overwriting work
 * from an earlier run. The unique `(campaign_id, plan_key)` constraint makes
 * this safe after a worker crash.
 */
export async function ensurePlannedAssets(
  campaignId: string,
  plannedAssets: PlannedAsset[],
): Promise<AssetRow[]> {
  if (plannedAssets.length === 0) return [];

  const { error: insertError } = await db()
    .from('assets')
    .upsert(
      plannedAssets.map((asset) => ({
        campaign_id: campaignId,
        plan_key: asset.plan_key,
        type: asset.type,
        platform: asset.platform,
        source_segment_ids: asset.segment_ids,
        status: 'planned',
      })),
      { onConflict: 'campaign_id,plan_key', ignoreDuplicates: true },
    );
  if (insertError) throw new Error(`Failed to create planned assets: ${insertError.message}`);

  const assets = await getCampaignAssets(campaignId);
  const byKey = new Map(assets.map((asset) => [asset.plan_key, asset]));
  for (const plan of plannedAssets) {
    const asset = byKey.get(plan.plan_key);
    if (!asset) throw new Error(`Plan ${plan.plan_key} did not produce an asset row.`);
    if (
      asset.type !== plan.type ||
      asset.platform !== plan.platform ||
      !sameIds(asset.source_segment_ids, plan.segment_ids)
    ) {
      throw new Error(
        `Existing asset ${plan.plan_key} no longer matches the approved strategy. Refusing to overwrite its history.`,
      );
    }
  }
  return plannedAssets.map((plan) => byKey.get(plan.plan_key)!);
}

export async function getCampaignAssets(
  campaignId: string,
  statuses?: AssetStatus[],
): Promise<AssetRow[]> {
  let query = db()
    .from('assets')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true });
  if (statuses?.length) query = query.in('status', statuses);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read campaign assets: ${error.message}`);
  return data ?? [];
}

/**
 * Atomically reserve the planned credits and move an asset to `generating`.
 * Calling this again for an asset already in `generating` is a no-op, which
 * closes the crash seam between charging credits and saving model output.
 */
export async function beginAssetGeneration(assetId: string, credits: number): Promise<number> {
  const { data, error } = await db().rpc('begin_asset_generation', {
    p_asset_id: assetId,
    p_credits: credits,
  });
  if (error) throw new Error(`Could not begin asset generation: ${error.message}`);
  if (data === null) throw new Error('Credit reservation returned no balance.');
  return data;
}

/** Reserve the one-credit revision cost and move a prepared asset to generating. */
export async function beginAssetRevision(assetId: string): Promise<number> {
  const { data, error } = await db().rpc('begin_asset_revision', {
    p_asset_id: assetId,
  });
  if (error) throw new Error(`Could not begin asset revision: ${error.message}`);
  if (data === null) throw new Error('Revision credit reservation returned no balance.');
  return data;
}

/** Mark a reviewed asset as passed. Repeating this after a worker crash is safe. */
export async function markAssetPassed(assetId: string): Promise<AssetRow> {
  return transitionAsset(assetId, 'passed', ['needs_review', 'passed']);
}

/** Preserve a rejected asset as history so it cannot enter the final package. */
export async function markAssetRejected(assetId: string): Promise<AssetRow> {
  return transitionAsset(assetId, 'rejected', ['needs_review', 'rejected']);
}

/** Preserve a passing asset as history when a campaign-level replan replaces it. */
export async function markAssetReplaced(assetId: string): Promise<AssetRow> {
  const { data, error } = await db()
    .from('assets')
    .update({ status: 'replaced', updated_at: new Date().toISOString() })
    .eq('id', assetId)
    .in('status', ['passed', 'replaced'])
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to preserve replaced asset: ${error.message}`);
  if (data) return data;

  const current = await getAsset(assetId);
  if (current.status === 'replaced') return current;
  throw new Error(`Asset ${assetId} cannot become replaced from status ${current.status}.`);
}

/**
 * Prepare one revision after a REVISE review. The conditional update makes the
 * increment idempotent if the worker dies after this node commits but before it
 * reaches `produce`.
 */
export async function prepareAssetRevision(
  assetId: string,
  expectedRevisionCount: number,
): Promise<AssetRow> {
  const nextRevision = expectedRevisionCount + 1;
  const { data, error } = await db()
    .from('assets')
    .update({
      status: 'revising',
      revision_count: nextRevision,
      updated_at: new Date().toISOString(),
    })
    .eq('id', assetId)
    .eq('status', 'needs_review')
    .eq('revision_count', expectedRevisionCount)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to prepare asset revision: ${error.message}`);
  if (data) return data;

  const current = await getAsset(assetId);
  if (current.status === 'revising' && current.revision_count === nextRevision) return current;
  throw new Error(
    `Asset ${assetId} could not be prepared for revision from status ${current.status} at revision ${current.revision_count}.`,
  );
}

/** An asset that has exhausted its revision path is excluded from the package. */
export async function abandonAsset(assetId: string): Promise<AssetRow> {
  const { data, error } = await db()
    .from('assets')
    .update({ status: 'abandoned', updated_at: new Date().toISOString() })
    .eq('id', assetId)
    .in('status', ['needs_review', 'rejected', 'revising'])
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to abandon asset: ${error.message}`);
  if (data) return data;

  const current = await getAsset(assetId);
  if (current.status === 'abandoned') return current;
  throw new Error(`Asset ${assetId} cannot be abandoned from status ${current.status}.`);
}

export async function getAsset(assetId: string): Promise<AssetRow> {
  const { data, error } = await db().from('assets').select('*').eq('id', assetId).single();
  if (error) throw new Error(`Failed to read asset ${assetId}: ${error.message}`);
  return data;
}

async function transitionAsset(
  assetId: string,
  target: 'passed' | 'rejected',
  allowed: string[],
): Promise<AssetRow> {
  const { data, error } = await db()
    .from('assets')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('id', assetId)
    .in('status', allowed)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to mark asset ${target}: ${error.message}`);
  if (data) return data;

  const current = await getAsset(assetId);
  if (current.status === target) return current;
  throw new Error(`Asset ${assetId} cannot become ${target} from status ${current.status}.`);
}

export async function saveVideoAsset(assetId: string, output: ProducedClip): Promise<AssetRow> {
  const content = {
    kind: 'short_video',
    hook: output.hook,
    caption: output.caption,
    clip_start: output.clipStart,
    clip_end: output.clipEnd,
    reasoning: output.reasoning,
    inspection: output.inspection,
    boundary_adjustments: output.boundaryAdjustments,
  } as Json;

  const { data, error } = await db()
    .from('assets')
    .update({
      hook: output.hook,
      content,
      media_url: output.mediaUrl,
      media_path: output.mediaPath,
      duration_sec: output.durationSec,
      status: 'needs_review',
      updated_at: new Date().toISOString(),
    })
    .eq('id', assetId)
    .eq('status', 'generating')
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to save video asset: ${error.message}`);
  if (!data) {
    throw new Error(`Asset ${assetId} was not generating, so its rendered media was not overwritten.`);
  }
  return data;
}

export async function saveWrittenAsset(assetId: string, output: WrittenAsset): Promise<AssetRow> {
  const content = {
    ...output.content,
    grounding: output.grounding,
  } as Json;

  const { data, error } = await db()
    .from('assets')
    .update({
      hook: output.hook,
      content,
      status: 'needs_review',
      updated_at: new Date().toISOString(),
    })
    .eq('id', assetId)
    .eq('status', 'generating')
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to save written asset: ${error.message}`);
  if (!data) {
    throw new Error(`Asset ${assetId} was not generating, so its content was not overwritten.`);
  }
  return data;
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((id) => expected.has(id));
}
