import { generateText, Output } from 'ai';
import type { z } from 'zod';
import { modelFor, modelIdFor, type ModelRole } from '@/lib/llm/client';
import { chargeCampaign, CostCeilingExceededError, resolveCostUsd } from '@/lib/llm/budget';
import { db } from '@/lib/db/client';
import { emit } from '@/lib/events';
import type { Json } from '@/lib/db/database.types';

/**
 * The single door every agent walks through to reach a model.
 *
 * No agent file imports the AI SDK. That rule is what makes three things
 * automatic rather than remembered: schema validation, one `agent_runs` row per
 * invocation, and cost charged against the campaign ceiling.
 *
 * AI SDK 7 replaced the standalone `generateObject` with `Output.object()` passed
 * to `generateText`; the parsed value comes back on `result.output`. That choice
 * lives here and only here, so a future API shift is one file.
 *
 * How much the repair pass matters depends on which provider served the call
 * (see `lib/llm/client.ts`). Through OpenRouter, OpenAI-compatible providers
 * default `supportsStructuredOutputs` to false: the schema is not enforced
 * server-side, the model is merely asked politely for JSON, and malformed
 * output is the expected path rather than the exceptional one. Called directly,
 * Claude enforces the schema through `output_config.format` and the repair pass
 * is a genuine safety net. It stays either way, because `MODEL_FAST` and
 * `MODEL_OVERRIDE_ALL` still route through OpenRouter.
 */

export interface StructuredCall<T> {
  /** Omit for spikes and tests: with no campaign there is nothing to log or charge. */
  campaignId?: string;
  agent: string;
  node?: string | null;
  role: ModelRole;
  schema: z.ZodType<T>;
  /** Passed to the provider as the schema name; some providers use it for guidance. */
  schemaName?: string;
  schemaDescription?: string;
  system?: string;
  prompt: string;
  /** Recorded verbatim to `agent_runs.input`, so a run can be replayed by hand. */
  input?: Json;
  /** Optional image inputs for multimodal judgement. Raw bytes are never written to agent_runs. */
  images?: Array<{ data: Uint8Array; mediaType: string; filename?: string }>;
  /** Repair attempts after the first failure. One is usually enough; then fail the node. */
  maxRepairAttempts?: number;
  onAttempt?: (info: AttemptInfo) => void;
}

export interface AttemptInfo {
  attempt: number;
  repaired: boolean;
  ok: boolean;
  error?: string;
  costUsd: number | null;
}

export interface StructuredResult<T> {
  value: T;
  runId: string | null;
  model: string;
  costUsd: number | null;
  attempts: AttemptInfo[];
  usage: { inputTokens?: number; outputTokens?: number };
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptInfo[],
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export async function callStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const model = modelIdFor(call.role);
  const maxRepairs = call.maxRepairAttempts ?? 1;
  const attempts: AttemptInfo[] = [];

  const runId = call.campaignId ? await startRun(call, model) : null;

  let prompt = call.prompt;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const repaired = attempt > 0;
    try {
      const result = await generateText({
        model: modelFor(call.role),
        system: call.system,
        ...(call.images?.length
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: [
                    { type: 'text' as const, text: prompt },
                    ...call.images.map((image) => ({
                      type: 'file' as const,
                      data: image.data,
                      mediaType: image.mediaType,
                      filename: image.filename,
                    })),
                  ],
                },
              ],
            }
          : { prompt }),
        output: Output.object({
          schema: call.schema,
          name: call.schemaName,
          description: call.schemaDescription,
        }),
      });

      // Output.object validates, but parse again so the returned value is
      // definitely the schema's inferred type and not a structurally similar one.
      const value = call.schema.parse(result.output);
      const costUsd = resolveCostUsd(model, result.providerMetadata);

      const info: AttemptInfo = { attempt, repaired, ok: true, costUsd };
      attempts.push(info);
      call.onAttempt?.(info);

      const usage = {
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      };

      if (call.campaignId && runId) {
        await finishRun(runId, {
          output: result.output as Json,
          model,
          promptTokens: usage.inputTokens ?? null,
          completionTokens: usage.outputTokens ?? null,
          costUsd,
        });
        await chargeCampaign(call.campaignId, costUsd, {
          agent: call.agent,
          node: call.node,
          model,
        });
        if (repaired) {
          await emit({
            campaignId: call.campaignId,
            agent: call.agent,
            node: call.node,
            level: 'warn',
            message: `${call.agent} returned invalid output and was repaired on retry.`,
          });
        }
      }

      return { value, runId, model, costUsd, attempts, usage };
    } catch (error) {
      // The ceiling is not a schema problem and must never be retried. It threw
      // from inside the try block above, so without this it lands in the generic
      // handler and the "repair" spends more money on an already-overdrawn
      // campaign, which is the exact runaway the ceiling exists to stop.
      if (error instanceof CostCeilingExceededError) {
        if (runId) await failRun(runId, error.message, model);
        throw error;
      }

      lastError = error;
      const description = describeError(error);
      const info: AttemptInfo = {
        attempt,
        repaired,
        ok: false,
        error: description,
        costUsd: resolveCostUsd(model, providerMetadataOf(error)),
      };
      attempts.push(info);
      call.onAttempt?.(info);

      // A failed attempt still burned tokens, but the SDK's error carries usage
      // without provider metadata, so there is no cost figure to charge. Say so
      // rather than let the campaign total quietly drift below reality.
      if (call.campaignId && info.costUsd === null) {
        const usage = usageOf(error);
        await emit({
          campaignId: call.campaignId,
          agent: call.agent,
          node: call.node,
          level: 'warn',
          message: `${call.agent} attempt ${attempt + 1} failed schema validation; its cost is not counted against the ceiling.`,
          data: { tokens: usage ?? null, error: description } as Json,
        });
      }

      if (attempt === maxRepairs) break;

      // Feed the exact failure back, plus what the model actually produced.
      // The spike showed why both halves matter: with only the SDK's top-level
      // "response did not match schema", the retry has nothing to act on and
      // fails identically. The violated constraint is what makes attempt two
      // worth paying for.
      const rawText = rawTextOf(error);
      prompt = [
        call.prompt,
        '',
        '---',
        'Your previous response could not be used.',
        ...(rawText ? ['', 'You returned:', truncate(rawText, 2000)] : []),
        '',
        'It failed validation because:',
        description,
        '',
        'Return only a JSON object that satisfies the schema. No prose, no code fences.',
      ].join('\n');
    }
  }

  const message = `${call.agent} failed to produce schema-valid output after ${attempts.length} attempt(s): ${describeError(lastError)}`;

  if (call.campaignId && runId) {
    await failRun(runId, message, model);
    await emit({
      campaignId: call.campaignId,
      agent: call.agent,
      node: call.node,
      level: 'error',
      message,
    });
  }
  throw new StructuredOutputError(message, attempts);
}

/**
 * Turn a thrown error into something a model can act on.
 *
 * The AI SDK buries the useful part: a schema violation surfaces as
 * `NoObjectGeneratedError("response did not match schema")`, and the actual Zod
 * issues sit two levels down the `cause` chain inside a `TypeValidationError`.
 * The spike proved the cost of not digging: the retry received only the generic
 * sentence and failed in exactly the same way.
 */
export function describeError(error: unknown): string {
  const issues = findZodIssues(error);
  if (issues) {
    return issues
      .map((issue) => {
        const i = issue as { path?: unknown[]; message?: string };
        const path = (i.path ?? []).join('.') || '(root)';
        return `${path}: ${i.message ?? 'invalid'}`;
      })
      .join('; ');
  }
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

/** Walks the `cause` chain for the first Zod-shaped `issues` array. */
function findZodIssues(error: unknown, depth = 0): unknown[] | null {
  if (!error || typeof error !== 'object' || depth > 5) return null;
  const record = error as Record<string, unknown>;
  if (Array.isArray(record.issues) && record.issues.length > 0) return record.issues;
  return findZodIssues(record.cause, depth + 1);
}

/** The raw model output, when the SDK preserved it (`NoObjectGeneratedError.text`). */
function rawTextOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const text = (error as Record<string, unknown>).text;
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

function usageOf(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return (error as Record<string, unknown>).usage;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated]`;
}

function providerMetadataOf(error: unknown): unknown {
  if (error && typeof error === 'object') {
    return (error as Record<string, unknown>).providerMetadata;
  }
  return undefined;
}

async function startRun<T>(call: StructuredCall<T>, model: string): Promise<string> {
  const { data, error } = await db()
    .from('agent_runs')
    .insert({
      campaign_id: call.campaignId!,
      agent: call.agent,
      node: call.node ?? 'unknown',
      input: call.input ?? ({ prompt: call.prompt } as Json),
      model,
      status: 'running',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to open agent_run: ${error.message}`);
  return data.id;
}

async function finishRun(
  runId: string,
  patch: {
    output: Json;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
  },
): Promise<void> {
  const { error } = await db()
    .from('agent_runs')
    .update({
      output: patch.output,
      model: patch.model,
      prompt_tokens: patch.promptTokens,
      completion_tokens: patch.completionTokens,
      cost_usd: patch.costUsd,
      status: 'succeeded',
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) console.error(`[structured] failed to close agent_run ${runId}: ${error.message}`);
}

async function failRun(runId: string, message: string, model: string): Promise<void> {
  const { error } = await db()
    .from('agent_runs')
    .update({
      status: 'failed',
      error: message,
      model,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) console.error(`[structured] failed to close agent_run ${runId}: ${error.message}`);
}
