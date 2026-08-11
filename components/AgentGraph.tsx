'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CampaignEvent } from '@/lib/events/types';
import {
  AGENT_ROSTER,
  deriveGraphState,
  GRAPH_EDGES,
  GRAPH_NODES,
  nodeMeta,
  type GraphNodeKind,
  type GraphNodeState,
  type GraphSide,
} from '@/lib/graph/view';
import type { CampaignSnapshot } from '@/components/useEventStream';

interface AgentGraphProps {
  campaign: Pick<CampaignSnapshot, 'status' | 'current_node'>;
  events: CampaignEvent[];
  compact?: boolean;
}

const NODE_WIDTH = 216;
const NODE_HEIGHT = 82;

const SIDE_TO_POSITION: Record<GraphSide, Position> = {
  t: Position.Top,
  b: Position.Bottom,
  l: Position.Left,
  r: Position.Right,
};

interface ChorusNodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  kind: GraphNodeKind;
  state: GraphNodeState;
  visits: number;
  caption: string | null;
  agentLabel: string | null;
}

interface ChorusEdgeData extends Record<string, unknown> {
  label?: string;
  traversed: boolean;
  active: boolean;
  loop: boolean;
  offset?: number;
}

type ChorusNode = Node<ChorusNodeData, 'chorus'>;
type ChorusEdge = Edge<ChorusEdgeData, 'chorus'>;

/**
 * One node on the map. It carries the live caption for its own node so that a
 * run reads as "who is doing what, right now" rather than a lit-up rectangle.
 */
const ChorusFlowNode = memo(function ChorusFlowNode({ data }: NodeProps<ChorusNode>) {
  const { label, subtitle, kind, state, visits, caption, agentLabel } = data;
  const dotState = kind === 'gate' && state === 'active' ? 'gate' : state;

  return (
    <div
      className={`chorus-node chorus-node--${state} chorus-node--${kind}`}
      style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
    >
      {(['t', 'b', 'l', 'r'] as const).map((side) => (
        <Handle
          key={`s-${side}`}
          id={`s-${side}`}
          type="source"
          position={SIDE_TO_POSITION[side]}
          isConnectable={false}
        />
      ))}
      {(['t', 'b', 'l', 'r'] as const).map((side) => (
        <Handle
          key={`t-${side}`}
          id={`t-${side}`}
          type="target"
          position={SIDE_TO_POSITION[side]}
          isConnectable={false}
        />
      ))}

      <div className="chorus-node__head">
        <span className={`chorus-state-dot chorus-state-dot-${dotState}`} aria-hidden />
        <span className="chorus-node__label">{label}</span>
        {visits > 1 && (
          <span className="chorus-node__visits" title={`Entered ${visits} times`}>
            &times;{visits}
          </span>
        )}
      </div>
      <span className="chorus-node__byline">{agentLabel ?? subtitle}</span>
      {state === 'active' && caption && <span className="chorus-node__caption">{caption}</span>}
    </div>
  );
});

/**
 * Edges are drawn by hand so a traversed path can be told apart from an
 * untaken one, and so the edge the run just crossed can carry a moving token.
 * `animateMotion` runs on the SVG compositor, so the token keeps moving without
 * costing a React render per frame.
 */
const ChorusFlowEdge = memo(function ChorusFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ChorusEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
    offset: data?.offset ?? 20,
  });

  const traversed = data?.traversed ?? false;
  const active = data?.active ?? false;
  const state = active ? 'active' : traversed && data?.loop ? 'looped' : traversed ? 'traversed' : 'idle';

  return (
    <>
      <BaseEdge id={id} path={path} className={`chorus-edge chorus-edge--${state}`} />
      {(active || (traversed && data?.loop)) && (
        <circle className="chorus-edge__token" r={4.5}>
          <animateMotion dur={active ? '1.8s' : '2.8s'} repeatCount="indefinite" path={path} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`chorus-edge__label chorus-edge__label--${state}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { chorus: ChorusFlowNode };
const edgeTypes = { chorus: ChorusFlowEdge };

/**
 * Keeps the active node in frame. Lives inside the flow because `useReactFlow`
 * needs the provider, and it renders nothing.
 */
function FollowCamera({ activeNode, enabled }: { activeNode: string | null; enabled: boolean }) {
  const { setCenter } = useReactFlow();
  const lastFocused = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !activeNode || activeNode === lastFocused.current) return;
    const definition = GRAPH_NODES.find((candidate) => candidate.id === activeNode);
    if (!definition) return;
    lastFocused.current = activeNode;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    setCenter(definition.position.x + NODE_WIDTH / 2, definition.position.y + NODE_HEIGHT / 2, {
      zoom: 1.02,
      duration: reduceMotion ? 0 : 720,
    });
  }, [activeNode, enabled, setCenter]);

  // Re-focusing after the toggle is switched back on should not wait for the
  // next node change, so forget the last target whenever following is disabled.
  useEffect(() => {
    if (!enabled) lastFocused.current = null;
  }, [enabled]);

  return null;
}

export function AgentGraph({ campaign, events, compact = false }: AgentGraphProps) {
  const [follow, setFollow] = useState(true);
  const derived = useMemo(() => deriveGraphState(campaign, events), [campaign, events]);

  const nodes = useMemo<ChorusNode[]>(
    () =>
      GRAPH_NODES.map((definition) => {
        const state = derived.states[definition.id];
        const meta = nodeMeta(derived, definition.id);
        const agent = definition.agent
          ? AGENT_ROSTER.find((candidate) => candidate.key === definition.agent)
          : undefined;

        return {
          id: definition.id,
          type: 'chorus' as const,
          position: definition.position,
          draggable: false,
          selectable: false,
          connectable: false,
          data: {
            label: definition.label,
            subtitle: definition.subtitle,
            kind: definition.kind,
            state,
            visits: meta.visits,
            caption: meta.lastMessage,
            // The live agent name beats the static one: `produce` runs both the
            // Writing Agent and the Clip Producer, and only the event knows which.
            agentLabel:
              state === 'active' && meta.lastAgent && meta.lastAgent !== 'system'
                ? agentLabelFor(meta.lastAgent)
                : (agent?.label ?? null),
          },
        };
      }),
    [derived],
  );

  const running = !['complete', 'failed', 'cancelled'].includes(campaign.status);

  const edges = useMemo<ChorusEdge[]>(
    () =>
      GRAPH_EDGES.map((definition) => ({
        id: definition.id,
        source: definition.source,
        target: definition.target,
        sourceHandle: `s-${definition.sourceSide ?? 'b'}`,
        targetHandle: `t-${definition.targetSide ?? 't'}`,
        type: 'chorus' as const,
        data: {
          label: definition.label,
          traversed: derived.traversedEdges.has(definition.id),
          // A finished run must not keep a token in flight on its last edge.
          active: running && derived.activeEdge === definition.id,
          loop: definition.loop ?? false,
          offset: definition.offset,
        },
      })),
    [derived, running],
  );

  return (
    <Card className={compact ? 'demo-panel h-full min-h-0 gap-0 overflow-hidden py-0' : 'overflow-hidden'}>
      <CardHeader className={compact ? 'border-b border-border px-4 py-3.5' : 'gap-2'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className={compact ? 'text-[15px]' : 'text-base'}>Campaign decision graph</CardTitle>
            <p className={compact ? 'text-muted-foreground mt-0.5 text-[11px]' : 'text-muted-foreground mt-1 text-xs'}>
              {derived.journey.length} node transition{derived.journey.length === 1 ? '' : 's'}, {' '}
              {events.length} event{events.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant={follow ? 'secondary' : 'ghost'}
              onClick={() => setFollow((value) => !value)}
              aria-pressed={follow}
            >
              {follow ? 'Following' : 'Follow'}
            </Button>
            <Badge variant={campaign.status === 'failed' ? 'destructive' : 'outline'}>
              {campaign.current_node ? campaign.current_node.replace(/_/g, ' ') : 'queued'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className={compact ? 'min-h-0 flex-1 p-0' : 'p-0'}>
        <div
          className={compact ? 'chorus-flow bg-muted/20 h-full min-h-[420px] w-full' : 'chorus-flow bg-muted/15 h-[640px] w-full border-y'}
          aria-label="Campaign agent graph"
        >
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.2, minZoom: 0.34, maxZoom: 1 }}
              minZoom={0.28}
              maxZoom={1.4}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              onPointerDown={() => setFollow(false)}
              proOptions={{ hideAttribution: true }}
            >
              <FollowCamera activeNode={derived.activeNode} enabled={follow && running} />
              <Background gap={24} size={1} color="var(--border)" />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      </CardContent>
      {!compact && <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px]" aria-label="Graph state legend">
          {(['idle', 'active', 'complete', 'failed'] as GraphNodeState[]).map((state) => (
            <span key={state} className="text-muted-foreground inline-flex items-center gap-1.5">
              <span className={`chorus-state-dot chorus-state-dot-${state}`} />
              {stateLabel(state)}
            </span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {AGENT_ROSTER.map((agent) => {
            const state = agentState(agent.key, agent.nodes, campaign, events);
            return (
              <div
                key={agent.key}
                className={`chorus-roster chorus-roster--${state} flex items-center gap-2.5 rounded-lg border px-2.5 py-2`}
              >
                <span className={`chorus-state-dot chorus-state-dot-${state}`} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{agent.label}</span>
                <span className="text-muted-foreground hidden truncate text-[10px] sm:block">
                  {agent.role}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>}
    </Card>
  );
}

function agentLabelFor(agent: string): string {
  return (
    AGENT_ROSTER.find((candidate) => candidate.key === agent)?.label ?? agent.replace(/_/g, ' ')
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
  // `produce` hosts two agents. Whichever one emitted last is the one working.
  if (campaign.current_node && nodes.includes(campaign.current_node)) {
    if (nodes.includes('produce') && campaign.current_node === 'produce') {
      const lastProducer = [...events]
        .reverse()
        .find((event) => event.agent === 'writing_agent' || event.agent === 'clip_producer');
      if (lastProducer && lastProducer.agent !== agent) {
        return events.some((event) => event.agent === agent) ? 'complete' : 'idle';
      }
    }
    return 'active';
  }
  if (events.some((event) => event.agent === agent)) return 'complete';
  return 'idle';
}

function stateLabel(state: GraphNodeState): string {
  return state === 'active' ? 'in progress' : state;
}
