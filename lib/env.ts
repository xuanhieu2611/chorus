/**
 * Single point of truth for configuration.
 *
 * Reads are lazy and validated at the call site rather than at import time, so a
 * missing GROQ_API_KEY does not stop `npm run build` or the Phase 0 worker from
 * running. Nothing here is exported to the browser: every consumer is a route
 * handler, the worker, or a script.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}. See .env.example.`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`Env var ${name} must be a number, got "${raw}".`);
  return parsed;
}

function positiveNum(name: string, fallback: number): number {
  const value = num(name, fallback);
  if (value <= 0) throw new Error(`Env var ${name} must be greater than zero, got "${value}".`);
  return value;
}

export const env = {
  get openrouterApiKey() {
    return required('OPENROUTER_API_KEY');
  },
  get groqApiKey() {
    return required('GROQ_API_KEY');
  },
  get supabaseUrl() {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },

  /**
   * Development escape hatch. When set, every role resolves to this one model,
   * leaving MODEL_REASONING/FAST/VISION intact as the real configuration.
   *
   * Iterating on prompts and graph wiring does not need a frontier model, and
   * paying frontier prices to discover that a node crashes is waste. Comment the
   * line out to get the real models back for a demo or a quality judgement.
   *
   * Anything set here must still accept images, or the Clip Producer's vision
   * pass breaks on video sources.
   */
  get modelOverrideAll() {
    const value = process.env.MODEL_OVERRIDE_ALL;
    return value && value.trim() !== '' ? value.trim() : null;
  },

  get modelReasoning() {
    return this.modelOverrideAll ?? process.env.MODEL_REASONING ?? 'anthropic/claude-sonnet-4.5';
  },
  get modelFast() {
    return this.modelOverrideAll ?? process.env.MODEL_FAST ?? 'google/gemini-2.5-flash';
  },
  get modelVision() {
    return this.modelOverrideAll ?? process.env.MODEL_VISION ?? 'anthropic/claude-sonnet-4.5';
  },

  get storageDir() {
    return process.env.STORAGE_DIR ?? './storage';
  },
  get ffmpegPath() {
    return process.env.FFMPEG_PATH ?? 'ffmpeg';
  },
  get ffprobePath() {
    return process.env.FFPROBE_PATH ?? 'ffprobe';
  },

  // Guardrails. Defaults mirror .env.example so a missing var never silently
  // means "unlimited".
  get maxRevisionsPerAsset() {
    return num('MAX_REVISIONS_PER_ASSET', 3);
  },
  get maxCampaignReplans() {
    return num('MAX_CAMPAIGN_REPLANS', 2);
  },
  get maxAssets() {
    return num('MAX_ASSETS', 6);
  },
  get defaultCreditBudget() {
    return num('DEFAULT_CREDIT_BUDGET', 12);
  },
  get campaignCostCeilingUsd() {
    return num('CAMPAIGN_COST_CEILING_USD', 3.0);
  },
  get staleClaimAfterSeconds() {
    return Math.max(30, positiveNum('STALE_CLAIM_AFTER_SECONDS', 90));
  },
};
