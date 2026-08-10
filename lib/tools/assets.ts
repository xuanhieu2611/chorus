import { db, type AssetRow } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import type { PlannedAsset } from '@/lib/agents/strategist';
import type { WrittenAsset } from '@/lib/agents/writer';

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
