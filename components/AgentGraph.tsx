'use client';

import { useMemo } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CampaignEvent } from '@/lib/events/types';
import {
  deriveGraphState,
  GRAPH_EDGES,
  GRAPH_NODES,
  type GraphNodeState,
} from '@/lib/graph/view';
import type { CampaignSnapshot } from '@/components/useEventStream';

interface AgentGraphProps {
  campaign: Pick<CampaignSnapshot, 'status' | 'current_node'>;
  events: CampaignEvent[];
}

interface FlowNodeData extends Record<string, unknown> {
  label: React.ReactNode;
}

type FlowNode = Node<FlowNodeData>;

const AGENTS = [
  { key: 'source_analyst', label: 'Source Analyst', nodes: ['analyze'] },
  { key: 'content_strategist', label: 'Content Strategist', nodes: ['strategize', 'select_alternative', 'replan'] },
  { key: 'content_director', label: 'Content Director', nodes: ['director_review_plan'] },
  { key: 'writing_agent', label: 'Writing Agent', nodes: ['produce'] },
  { key: 'clip_producer', label: 'Clip Producer', nodes: ['produce'] },
  { key: 'content_critic', label: 'Content Critic', nodes: ['critique'] },
  { key: 'campaign_reviewer', label: 'Campaign Reviewer', nodes: ['campaign_review'] },
] as const;

export function AgentGraph({ campaign, events }: AgentGraphProps) {
  const derived = useMemo(
    () => deriveGraphState(campaign, events),
    [campaign, events],
  );

  const nodes = useMemo<FlowNode[]>(
    () =>
      GRAPH_NODES.map((definition) => {
        const state = derived.states[definition.id];
        return {
          id: definition.id,
          type: 'default',
          position: definition.position,
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          draggable: false,
          selectable: false,
          className: `chorus-graph-node chorus-graph-node-${state} chorus-graph-node-${definition.kind}`,
          style: { width: 194 },
          data: {
            label: (
              <div className="chorus-graph-node-content">
                <span className="chorus-graph-node-title">{definition.label}</span>
                {definition.subtitle && (
                  <span className="chorus-graph-node-subtitle">{definition.subtitle}</span>
                )}
                <span className="chorus-graph-node-state">{stateLabel(state)}</span>
              </div>
            ),
          },
        };
      }),
    [derived.states],
  );

  const edges = useMemo<Edge[]>(
    () =>
      GRAPH_EDGES.map((definition) => {
        const traversed = derived.traversedEdges.has(definition.id);
        return {
          id: definition.id,
          source: definition.source,
          target: definition.target,
          type: 'smoothstep',
          label: definition.label,
          animated: definition.loop && traversed,
          className: definition.loop && traversed ? 'chorus-loop-edge' : undefined,
          style: {
            stroke: definition.loop && traversed ? '#06b6d4' : 'var(--muted-foreground)',
            strokeWidth: definition.loop && traversed ? 2 : 1,
          },
          labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--background)', fillOpacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }),
    [derived.traversedEdges],
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Agent graph</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              Fixed control-flow map · {events.length} event{events.length === 1 ? '' : 's'} observed
            </p>
          </div>
          <Badge variant={campaign.status === 'failed' ? 'destructive' : 'outline'}>
            {campaign.current_node ? campaign.current_node.replace(/_/g, ' ') : 'queued'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="chorus-flow h-[620px] w-full border-y bg-muted/15" aria-label="Campaign agent graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            fitViewOptions={{ padding: 0.16, minZoom: 0.38, maxZoom: 0.9 }}
            minZoom={0.3}
            maxZoom={1.2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} color="var(--border)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        </div>
      </CardContent>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px]" aria-label="Graph state legend">
          {(['idle', 'active', 'complete', 'failed', 'skipped'] as GraphNodeState[]).map((state) => (
            <span key={state} className="text-muted-foreground inline-flex items-center gap-1.5">
              <span className={`chorus-state-dot chorus-state-dot-${state}`} />
              {stateLabel(state)}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AGENTS.map((agent) => {
            const state = agentState(agent.key, agent.nodes, campaign, events);
            return (
              <div key={agent.key} className="bg-muted/35 flex items-center gap-2 rounded-lg border px-2.5 py-2">
                <span className={`chorus-state-dot chorus-state-dot-${state}`} />
                <span className="min-w-0 truncate text-xs">{agent.label}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function agentState(
  agent: string,
  nodes: readonly string[],
  campaign: AgentGraphProps['campaign'],
  events: CampaignEvent[],
): Exclude<GraphNodeState, 'skipped'> {
  if (campaign.status === 'failed' && campaign.current_node && nodes.includes(campaign.current_node)) {
    return 'failed';
  }
  if (campaign.current_node && nodes.includes(campaign.current_node)) return 'active';
  if (events.some((event) => event.agent === agent)) return 'complete';
  return 'idle';
}

function stateLabel(state: GraphNodeState): string {
  return state === 'active' ? 'in progress' : state;
}
