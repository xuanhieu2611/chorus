import type { CampaignEvent } from '@/lib/events/types';

export type GraphNodeState = 'idle' | 'active' | 'complete' | 'failed' | 'skipped';

export type GraphNodeKind = 'start' | 'mechanism' | 'agent' | 'gate' | 'decision' | 'end';

/** Handle ids exist on every node so loop edges can leave and enter from a side. */
export type GraphSide = 't' | 'b' | 'l' | 'r';

export interface GraphNodeDefinition {
  id: string;
  label: string;
  subtitle?: string;
  /** The agent that owns this node, when one does. Drives the roster and the node byline. */
  agent?: string;
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
  sourceSide?: GraphSide;
  targetSide?: GraphSide;
  /** How far a routed edge bows away from the spine, so parallel loops do not overlap. */
  offset?: number;
}

const COL_MAIN = 340;
const COL_LEFT = 30;
const COL_RIGHT = 650;
const ROW = 104;

/** Row index to y, so inserting a node does not mean retyping every coordinate. */
function row(index: number): number {
  return index * ROW;
}

/**
 * The display graph mirrors MVP.md section 6. Positions are deliberately fixed:
 * the campaign graph is known, and a stable map makes a run readable while it
 * is changing. `more_assets` is a display-only decision because the executor
 * resolves that branch inside `produce`, `critique`, and `abandon_asset`.
 */
export const GRAPH_NODES: readonly GraphNodeDefinition[] = [
  { id: 'start', label: 'Campaign queued', kind: 'start', position: { x: COL_MAIN, y: row(0) } },
  {
    id: 'ingest',
    label: 'ingest',
    subtitle: 'ffprobe + audio extract',
    kind: 'mechanism',
    runtimeNode: 'ingest',
    position: { x: COL_MAIN, y: row(1) },
  },
  {
    id: 'transcribe',
    label: 'transcribe',
    subtitle: 'Whisper word timestamps',
    kind: 'mechanism',
    runtimeNode: 'transcribe',
    position: { x: COL_MAIN, y: row(2) },
  },
  {
    id: 'analyze',
    label: 'analyze',
    subtitle: 'finds candidate topics',
    agent: 'source_analyst',
    kind: 'agent',
    runtimeNode: 'analyze',
    position: { x: COL_MAIN, y: row(3) },
  },
  {
    id: 'strategize',
    label: 'strategize',
    subtitle: 'picks what is worth making',
    agent: 'content_strategist',
    kind: 'agent',
    runtimeNode: 'strategize',
    position: { x: COL_MAIN, y: row(4) },
  },
  {
    id: 'director_review_plan',
    label: 'director review',
    subtitle: 'approves or rejects the plan',
    agent: 'content_director',
    kind: 'decision',
    runtimeNode: 'director_review_plan',
    position: { x: COL_MAIN, y: row(5) },
  },
  {
    id: 'await_strategy_approval',
    label: 'strategy gate',
    subtitle: 'waits for a human',
    kind: 'gate',
    runtimeNode: 'await_strategy_approval',
    position: { x: COL_MAIN, y: row(6) },
  },
  {
    id: 'produce',
    label: 'produce',
    subtitle: 'writes copy, renders clips',
    agent: 'clip_producer',
    kind: 'agent',
    runtimeNode: 'produce',
    position: { x: COL_MAIN, y: row(7) },
  },
  {
    id: 'critique',
    label: 'critique',
    subtitle: 'scores its own output',
    agent: 'content_critic',
    kind: 'agent',
    runtimeNode: 'critique',
    position: { x: COL_MAIN, y: row(8) },
  },
  {
    id: 'more_assets',
    label: 'assets remaining?',
    subtitle: 'portfolio loop',
    kind: 'decision',
    position: { x: COL_MAIN, y: row(9) },
  },
  {
    id: 'campaign_review',
    label: 'campaign review',
    subtitle: 'judges the portfolio',
    agent: 'campaign_reviewer',
    kind: 'decision',
    runtimeNode: 'campaign_review',
    position: { x: COL_MAIN, y: row(10) },
  },
  {
    id: 'await_final_approval',
    label: 'final gate',
    subtitle: 'waits for a human',
    kind: 'gate',
    runtimeNode: 'await_final_approval',
    position: { x: COL_MAIN, y: row(11) },
  },
  {
    id: 'finalize',
    label: 'finalize',
    subtitle: 'packages the campaign',
    kind: 'mechanism',
    runtimeNode: 'finalize',
    position: { x: COL_MAIN, y: row(12) },
  },
  { id: 'done', label: 'Campaign complete', kind: 'end', position: { x: COL_MAIN, y: row(13) } },
  {
    id: 'select_alternative',
    label: 'select alternative',
    subtitle: 'swaps the source topic',
    agent: 'content_strategist',
    kind: 'agent',
    runtimeNode: 'select_alternative',
    position: { x: COL_LEFT, y: row(8) },
  },
  {
    id: 'abandon_asset',
    label: 'abandon asset',
    subtitle: 'gives up on this one',
    kind: 'mechanism',
    runtimeNode: 'abandon_asset',
    position: { x: COL_LEFT, y: row(9) },
  },
  {
    id: 'replan',
    label: 'replan',
    subtitle: 'revises the whole plan',
    agent: 'content_strategist',
    kind: 'agent',
    runtimeNode: 'replan',
    position: { x: COL_RIGHT, y: row(10) },
  },
];

/**
 * Loop and skip edges leave from a side rather than the bottom, and each one
 * bows by a different offset. Without that they collapse onto each other and
 * the revise/replan cycles, which are the whole point of the graph, become
 * unreadable exactly when they start firing.
 */
export const GRAPH_EDGES: readonly GraphEdgeDefinition[] = [
  edge('start', 'ingest'),
  edge('ingest', 'transcribe'),
  edge('transcribe', 'analyze'),
  edge('analyze', 'strategize'),
  edge('strategize', 'director_review_plan'),
  route('director_review_plan', 'strategize', 'REJECT · replan left', { loop: true, side: 'l', offset: 46 }),
  route('director_review_plan', 'finalize', 'REJECT · no replans left', { side: 'r', offset: 54 }),
  edge('director_review_plan', 'await_strategy_approval', 'APPROVE'),
  route('await_strategy_approval', 'strategize', 'Request changes', { loop: true, side: 'l', offset: 116 }),
  edge('await_strategy_approval', 'produce', 'Approve'),
  edge('produce', 'critique'),
  edge('critique', 'more_assets', 'PASS'),
  route('critique', 'produce', 'REVISE', { loop: true, side: 'r', offset: 46 }),
  route('critique', 'select_alternative', 'REJECT', { sourceSide: 'l', targetSide: 'r', offset: 24 }),
  route('critique', 'abandon_asset', 'REVISE · limit', { sourceSide: 'l', targetSide: 'r', offset: 96 }),
  route('select_alternative', 'produce', 'alternative found', {
    loop: true,
    sourceSide: 't',
    targetSide: 'l',
    offset: 40,
  }),
  edge('select_alternative', 'abandon_asset', 'none left'),
  route('abandon_asset', 'more_assets', undefined, { sourceSide: 'r', targetSide: 'l', offset: 24 }),
  route('more_assets', 'produce', 'yes', { loop: true, side: 'r', offset: 118 }),
  edge('more_assets', 'campaign_review', 'no'),
  route('campaign_review', 'replan', 'REPLAN · under limit', {
    loop: true,
    sourceSide: 'r',
    targetSide: 'l',
    offset: 24,
  }),
  edge('campaign_review', 'await_final_approval', 'APPROVE / limit'),
  route('replan', 'produce', undefined, { loop: true, sourceSide: 't', targetSide: 'r', offset: 190 }),
  route('await_final_approval', 'replan', 'Request changes', {
    loop: true,
    sourceSide: 'r',
    targetSide: 'b',
    offset: 60,
  }),
  edge('await_final_approval', 'finalize', 'Approve'),
  edge('finalize', 'done'),
];

/**
 * The seven agents, in the order they first get to act. `produce` is shared:
 * the Writing Agent and the Clip Producer both run under it and are told apart
 * by the `agent` field on their events, not by the node.
 */
export const AGENT_ROSTER = [
  { key: 'source_analyst', label: 'Source Analyst', role: 'finds what is worth using', nodes: ['analyze'] },
  {
    key: 'content_strategist',
    label: 'Content Strategist',
    role: 'plans the campaign',
    nodes: ['strategize', 'select_alternative', 'replan'],
  },
  {
    key: 'content_director',
    label: 'Content Director',
    role: 'approves the plan',
    nodes: ['director_review_plan'],
  },
  { key: 'writing_agent', label: 'Writing Agent', role: 'writes grounded copy', nodes: ['produce'] },
  { key: 'clip_producer', label: 'Clip Producer', role: 'renders vertical clips', nodes: ['produce'] },
  { key: 'content_critic', label: 'Content Critic', role: 'scores every asset', nodes: ['critique'] },
  {
    key: 'campaign_reviewer',
    label: 'Campaign Reviewer',
    role: 'judges the portfolio',
    nodes: ['campaign_review'],
  },
] as const;

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

/** What a single node has done so far, used for the byline and the loop counter. */
export interface GraphNodeMeta {
  /** How many times the executor has entered this node. Above one means a loop fired. */
  visits: number;
  /** The most recent thing said at this node, which is what makes a node look alive. */
  lastMessage: string | null;
  lastAgent: string | null;
  lastAt: string | null;
  firstAt: string | null;
}

export interface GraphJourneyStep {
  eventId: number;
  node: string;
  agent: string;
  message: string;
  at: string;
}

export interface DerivedGraphState {
  states: Record<string, GraphNodeState>;
  traversedEdges: Set<string>;
  /** The edge the run most recently crossed. The travelling token rides this one. */
  activeEdge: string | null;
  activeNode: string | null;
  meta: Record<string, GraphNodeMeta>;
  /** Node entries in order, which is the readable story of the run. */
  journey: GraphJourneyStep[];
}

const EMPTY_META: GraphNodeMeta = {
  visits: 0,
  lastMessage: null,
  lastAgent: null,
  lastAt: null,
  firstAt: null,
};

export function deriveGraphState(
  campaign: GraphCampaignState | null,
  events: readonly CampaignEvent[],
): DerivedGraphState {
  const visited = new Set<string>();
  const traversedEdges = new Set<string>();
  const meta: Record<string, GraphNodeMeta> = {};
  const journey: GraphJourneyStep[] = [];
  let lastRuntimeNode: string | null = null;
  let activeEdge: string | null = null;

  const markEdge = (id: string) => {
    traversedEdges.add(id);
    activeEdge = id;
  };

  for (const event of events) {
    const displayNode = event.node ? RUNTIME_TO_DISPLAY.get(event.node) : undefined;
    if (displayNode) {
      visited.add(displayNode);
      lastRuntimeNode = displayNode;

      const current = meta[displayNode] ?? { ...EMPTY_META };
      const entering = isNodeEntry(event);
      meta[displayNode] = {
        visits: current.visits + (entering ? 1 : 0),
        // "Entering produce." is scaffolding; anything the agent says afterwards
        // is the interesting line, so a later event always wins.
        lastMessage: event.message,
        lastAgent: event.agent,
        lastAt: event.created_at,
        firstAt: current.firstAt ?? event.created_at,
      };

      if (entering) {
        journey.push({
          eventId: event.id,
          node: displayNode,
          agent: event.agent,
          message: event.message,
          at: event.created_at,
        });
      }
    }

    if (event.level !== 'decision' || !event.node || !displayNode) continue;
    const next = nextNodeFromEvent(event.data);
    if (!next) continue;

    const nextDisplayNode = RUNTIME_TO_DISPLAY.get(next) ?? next;
    if (event.node === 'critique' && event.message.includes('PASS')) {
      visited.add('more_assets');
      traversedEdges.add(graphEdgeId('critique', 'more_assets'));
      markEdge(graphEdgeId('more_assets', nextDisplayNode));
      continue;
    }
    if (event.node === 'abandon_asset' && nextDisplayNode === 'produce') {
      visited.add('more_assets');
      traversedEdges.add(graphEdgeId('abandon_asset', 'more_assets'));
      markEdge(graphEdgeId('more_assets', 'produce'));
      continue;
    }
    const id = graphEdgeId(displayNode, nextDisplayNode);
    if (GRAPH_EDGES.some((candidate) => candidate.id === id)) markEdge(id);
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
      state = campaign?.status === 'failed' ? 'failed' : campaign?.status === 'complete' ? 'complete' : 'active';
    }
    if (node.id === 'done') state = 'idle';
    states[node.id] = state;
  }

  if (campaign?.status === 'failed' && currentDisplayNode && NODE_IDS.has(currentDisplayNode)) {
    states[currentDisplayNode] = 'failed';
  }
  if (campaign?.status === 'complete') {
    states.done = 'complete';
  }

  const activeNode = Object.keys(states).find((id) => states[id] === 'active') ?? null;

  return { states, traversedEdges, activeEdge, activeNode, meta, journey };
}

export function nodeMeta(derived: DerivedGraphState, id: string): GraphNodeMeta {
  return derived.meta[id] ?? EMPTY_META;
}

/**
 * The executor emits exactly one `Entering <node>.` line per visit, which is
 * what makes visit counting reliable enough to show a `x3` badge on a node.
 */
function isNodeEntry(event: CampaignEvent): boolean {
  return event.level === 'info' && event.message.startsWith('Entering ');
}

function edge(source: string, target: string, label?: string): GraphEdgeDefinition {
  return { id: graphEdgeId(source, target), source, target, label, loop: false, sourceSide: 'b', targetSide: 't' };
}

function route(
  source: string,
  target: string,
  label: string | undefined,
  options: { loop?: boolean; side?: GraphSide; sourceSide?: GraphSide; targetSide?: GraphSide; offset?: number },
): GraphEdgeDefinition {
  return {
    id: graphEdgeId(source, target),
    source,
    target,
    label,
    loop: options.loop ?? false,
    sourceSide: options.sourceSide ?? options.side ?? 'b',
    targetSide: options.targetSide ?? options.side ?? 't',
    offset: options.offset,
  };
}

function nextNodeFromEvent(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const next = (data as { next?: unknown }).next;
  return typeof next === 'string' ? next : null;
}
