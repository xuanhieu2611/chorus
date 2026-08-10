import type { CampaignEvent } from '@/lib/events/types';

export type GraphNodeState = 'idle' | 'active' | 'complete' | 'failed' | 'skipped';

export type GraphNodeKind = 'start' | 'mechanism' | 'agent' | 'gate' | 'decision' | 'end';

export interface GraphNodeDefinition {
  id: string;
  label: string;
  subtitle?: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
  runtimeNode?: string;
}

export interface GraphEdgeDefinition {
  id: string;
  source: string;
  target: string;
  label?: string;
  loop?: boolean;
}

/**
 * The display graph mirrors MVP.md section 6. Positions are deliberately fixed:
 * the campaign graph is known, and a stable map makes a run readable while it
 * is changing. `more_assets` is a display-only decision because the executor
 * resolves that branch inside `produce`, `critique`, and `abandon_asset`.
 */
export const GRAPH_NODES: readonly GraphNodeDefinition[] = [
  { id: 'start', label: 'Campaign queued', kind: 'start', position: { x: 360, y: 0 } },
  {
    id: 'ingest',
    label: 'ingest',
    subtitle: 'ffprobe + audio',
    kind: 'mechanism',
    runtimeNode: 'ingest',
    position: { x: 360, y: 92 },
  },
  {
    id: 'transcribe',
    label: 'transcribe',
    subtitle: 'Whisper timestamps',
    kind: 'mechanism',
    runtimeNode: 'transcribe',
    position: { x: 360, y: 184 },
  },
  {
    id: 'analyze',
    label: 'analyze',
    subtitle: 'Source Analyst',
    kind: 'agent',
    runtimeNode: 'analyze',
    position: { x: 360, y: 276 },
  },
  {
    id: 'strategize',
    label: 'strategize',
    subtitle: 'Content Strategist',
    kind: 'agent',
    runtimeNode: 'strategize',
    position: { x: 360, y: 368 },
  },
  {
    id: 'director_review_plan',
    label: 'director review',
    subtitle: 'Content Director',
    kind: 'decision',
    runtimeNode: 'director_review_plan',
    position: { x: 360, y: 460 },
  },
  {
    id: 'await_strategy_approval',
    label: 'strategy gate',
    subtitle: 'Human approval',
    kind: 'gate',
    runtimeNode: 'await_strategy_approval',
    position: { x: 360, y: 552 },
  },
  {
    id: 'produce',
    label: 'produce',
    subtitle: 'Clip + Writing Agents',
    kind: 'agent',
    runtimeNode: 'produce',
    position: { x: 360, y: 644 },
  },
  {
    id: 'critique',
    label: 'critique',
    subtitle: 'Content Critic',
    kind: 'agent',
    runtimeNode: 'critique',
    position: { x: 360, y: 736 },
  },
  {
    id: 'more_assets',
    label: 'assets remaining?',
    subtitle: 'portfolio loop',
    kind: 'decision',
    position: { x: 360, y: 828 },
  },
  {
    id: 'campaign_review',
    label: 'campaign review',
    subtitle: 'Campaign Reviewer',
    kind: 'decision',
    runtimeNode: 'campaign_review',
    position: { x: 360, y: 920 },
  },
  {
    id: 'await_final_approval',
    label: 'final gate',
    subtitle: 'Human approval',
    kind: 'gate',
    runtimeNode: 'await_final_approval',
    position: { x: 360, y: 1012 },
  },
  {
    id: 'finalize',
    label: 'finalize',
    subtitle: 'Phase 9 package',
    kind: 'mechanism',
    runtimeNode: 'finalize',
    position: { x: 360, y: 1104 },
  },
  { id: 'done', label: 'Campaign complete', kind: 'end', position: { x: 360, y: 1196 } },
  {
    id: 'select_alternative',
    label: 'select alternative',
    subtitle: 'Strategist',
    kind: 'agent',
    runtimeNode: 'select_alternative',
    position: { x: 40, y: 736 },
  },
  {
    id: 'abandon_asset',
    label: 'abandon asset',
    subtitle: 'mechanism',
    kind: 'mechanism',
    runtimeNode: 'abandon_asset',
    position: { x: 40, y: 828 },
  },
  {
    id: 'replan',
    label: 'replan',
    subtitle: 'Strategist revises plan',
    kind: 'agent',
    runtimeNode: 'replan',
    position: { x: 680, y: 920 },
  },
];

export const GRAPH_EDGES: readonly GraphEdgeDefinition[] = [
  edge('start', 'ingest'),
  edge('ingest', 'transcribe'),
  edge('transcribe', 'analyze'),
  edge('analyze', 'strategize'),
  edge('strategize', 'director_review_plan'),
  edge('director_review_plan', 'strategize', 'REJECT · replan left', true),
  edge('director_review_plan', 'finalize', 'REJECT · no replans', false),
  edge('director_review_plan', 'await_strategy_approval', 'APPROVE'),
  edge('await_strategy_approval', 'strategize', 'Request changes', true),
  edge('await_strategy_approval', 'produce', 'Approve'),
  edge('produce', 'critique'),
  edge('critique', 'more_assets', 'PASS'),
  edge('critique', 'produce', 'REVISE', true),
  edge('critique', 'select_alternative', 'REJECT'),
  edge('critique', 'abandon_asset', 'REVISE · limit'),
  edge('select_alternative', 'produce', 'alternative found', true),
  edge('select_alternative', 'abandon_asset', 'none left'),
  edge('abandon_asset', 'more_assets'),
  edge('more_assets', 'produce', 'yes', true),
  edge('more_assets', 'campaign_review', 'no'),
  edge('campaign_review', 'replan', 'REPLAN · under limit', true),
  edge('campaign_review', 'await_final_approval', 'APPROVE / limit'),
  edge('replan', 'produce', undefined, true),
  edge('await_final_approval', 'replan', 'Request changes', true),
  edge('await_final_approval', 'finalize', 'Approve'),
  edge('finalize', 'done'),
];

export const LOOP_EDGE_IDS = new Set(
  GRAPH_EDGES.filter((candidate) => candidate.loop).map((candidate) => candidate.id),
);

const NODE_IDS = new Set(GRAPH_NODES.map((node) => node.id));
const RUNTIME_TO_DISPLAY = new Map(
  GRAPH_NODES.filter((node) => node.runtimeNode).map((node) => [node.runtimeNode!, node.id]),
);

export function graphEdgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

export interface GraphCampaignState {
  status: string;
  current_node: string | null;
}

export interface DerivedGraphState {
  states: Record<string, GraphNodeState>;
  traversedEdges: Set<string>;
}

export function deriveGraphState(
  campaign: GraphCampaignState | null,
  events: readonly CampaignEvent[],
): DerivedGraphState {
  const visited = new Set<string>();
  const traversedEdges = new Set<string>();
  let lastRuntimeNode: string | null = null;

  for (const event of events) {
    const displayNode = event.node ? RUNTIME_TO_DISPLAY.get(event.node) : undefined;
    if (displayNode) {
      visited.add(displayNode);
      lastRuntimeNode = displayNode;
    }

    if (event.level !== 'decision' || !event.node || !displayNode) continue;
    const next = nextNodeFromEvent(event.data);
    if (!next) continue;

    const nextDisplayNode = RUNTIME_TO_DISPLAY.get(next) ?? next;
    if (event.node === 'critique' && event.message.includes('PASS')) {
      visited.add('more_assets');
      traversedEdges.add(graphEdgeId('critique', 'more_assets'));
      traversedEdges.add(graphEdgeId('more_assets', nextDisplayNode));
      continue;
    }
    if (event.node === 'abandon_asset' && nextDisplayNode === 'produce') {
      visited.add('more_assets');
      traversedEdges.add(graphEdgeId('abandon_asset', 'more_assets'));
      traversedEdges.add(graphEdgeId('more_assets', 'produce'));
      continue;
    }
    const id = graphEdgeId(displayNode, nextDisplayNode);
    if (GRAPH_EDGES.some((candidate) => candidate.id === id)) traversedEdges.add(id);
  }

  const currentDisplayNode = campaign?.current_node
    ? (RUNTIME_TO_DISPLAY.get(campaign.current_node) ?? campaign.current_node)
    : null;
  if (currentDisplayNode && NODE_IDS.has(currentDisplayNode)) visited.add(currentDisplayNode);

  const states: Record<string, GraphNodeState> = {};
  for (const node of GRAPH_NODES) {
    let state: GraphNodeState = visited.has(node.id) ? 'complete' : 'idle';
    if (node.id === 'start' && campaign?.status === 'queued' && !lastRuntimeNode) state = 'active';
    if (currentDisplayNode === node.id) {
      state = campaign?.status === 'failed' ? 'failed' : 'active';
    }
    if (node.id === 'finalize' && currentDisplayNode === 'finalize' && campaign?.status === 'complete') {
      state = 'skipped';
    }
    if (node.id === 'done') state = 'idle';
    states[node.id] = state;
  }

  if (campaign?.status === 'failed' && currentDisplayNode && NODE_IDS.has(currentDisplayNode)) {
    states[currentDisplayNode] = 'failed';
  }

  return { states, traversedEdges };
}

function edge(
  source: string,
  target: string,
  label?: string,
  loop = false,
): GraphEdgeDefinition {
  return { id: graphEdgeId(source, target), source, target, label, loop };
}

function nextNodeFromEvent(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const next = (data as { next?: unknown }).next;
  return typeof next === 'string' ? next : null;
}
