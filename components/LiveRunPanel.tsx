'use client';

import { AGENT_ROSTER } from '@/lib/graph/view';
import type { CampaignEvent } from '@/lib/events/types';
import type { CampaignSnapshot, EventStreamStatus } from '@/components/useEventStream';

const AGENT_NODES: Record<string, readonly string[]> = Object.fromEntries(
  AGENT_ROSTER.map((agent) => [agent.key, agent.nodes]),
);

export function LiveRunPanel({
  campaign,
  events,
  connectionStatus,
}: {
  campaign: CampaignSnapshot;
  events: CampaignEvent[];
  connectionStatus: EventStreamStatus;
}) {
  const latest = [...events]
    .reverse()
    .filter((event) => event.level !== 'tool')
    .at(0) ?? [...events].reverse()[0] ?? null;

  return (
    <aside className="demo-panel flex min-h-0 flex-col overflow-hidden" aria-label="Live agent activity">
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="chorus-live-orb" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Live run</h2>
        </div>
        <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-[0.12em]">
          {connectionLabel(connectionStatus)}
        </span>
      </div>

      <div className="border-b border-border p-4">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          {latest ? agentLabel(latest.agent) : 'System'}
        </p>
        <p className="mt-2 line-clamp-3 min-h-[3.75rem] text-[15px] leading-5 text-pretty">
          {latest?.message ?? 'Waiting for the worker to begin.'}
        </p>
        <div className="mt-3 flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground font-mono">
            {campaign.current_node?.replace(/_/g, ' ') ?? 'queued'}
          </span>
          <span className="text-border">/</span>
          <span className="text-muted-foreground font-mono">{events.length} events</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 px-3 py-2">
        <p className="text-muted-foreground px-1 py-2 text-[11px] font-medium uppercase tracking-[0.12em]">
          Agent team
        </p>
        <ol className="space-y-0.5">
          {AGENT_ROSTER.map((agent) => {
            const state = getAgentState(agent.key, campaign, events);
            return (
              <li key={agent.key} className={`agent-line agent-line--${state}`}>
                <span className={`chorus-state-dot chorus-state-dot-${state}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.label}</span>
                <span className="text-muted-foreground truncate text-[11px]">
                  {state === 'active' ? activeVerb(agent.key) : state === 'complete' ? 'done' : 'waiting'}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

    </aside>
  );
}

function getAgentState(
  agent: string,
  campaign: Pick<CampaignSnapshot, 'status' | 'current_node'>,
  events: CampaignEvent[],
): 'idle' | 'active' | 'complete' | 'failed' {
  const nodes = AGENT_NODES[agent] ?? [];
  const currentNode = campaign.current_node;
  if (campaign.status === 'failed' && currentNode && nodes.includes(currentNode)) return 'failed';

  if (currentNode && nodes.includes(currentNode)) {
    if (currentNode === 'produce') {
      const lastProducer = [...events]
        .reverse()
        .find((event) => event.agent === 'writing_agent' || event.agent === 'clip_producer');
      if (lastProducer && lastProducer.agent !== agent) {
        return events.some((event) => event.agent === agent) ? 'complete' : 'idle';
      }
    }
    return 'active';
  }

  return events.some((event) => event.agent === agent || (event.node && nodes.includes(event.node)))
    ? 'complete'
    : 'idle';
}

function agentLabel(agent: string): string {
  return AGENT_ROSTER.find((candidate) => candidate.key === agent)?.label ?? agent.replace(/_/g, ' ');
}

function activeVerb(agent: string): string {
  return {
    source_analyst: 'mapping source',
    content_strategist: 'planning',
    content_director: 'reviewing',
    writing_agent: 'writing',
    clip_producer: 'rendering',
    content_critic: 'critiquing',
    campaign_reviewer: 'reviewing set',
  }[agent] ?? 'working';
}

function connectionLabel(status: EventStreamStatus): string {
  if (status === 'connected') return 'streaming';
  if (status === 'reconnecting') return 'reconnecting';
  if (status === 'error') return 'offline';
  return 'connecting';
}
