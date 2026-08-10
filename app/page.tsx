import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Phase 0 placeholder. The real new-campaign form (upload + growth objective)
 * lands in Phase 1 once the upload route and ingest node exist.
 */
const PHASES = [
  { id: 0, name: 'Foundation', detail: 'Scaffold, schema, LLM wrapper, worker claim loop' },
  { id: 1, name: 'Ingest and transcribe', detail: 'Upload, ffprobe, Groq with chunk-offset merge' },
  { id: 2, name: 'Source Analyst', detail: 'Map-reduce segment extraction' },
  { id: 3, name: 'Strategist, Director, first gate', detail: 'Plan, review, human approval' },
  { id: 4, name: 'Writing Agent', detail: 'Text assets with grounding verification' },
  { id: 5, name: 'Clip Producer', detail: 'Draft cut, inspect, 9:16 render with captions' },
  { id: 6, name: 'Critic and revision loop', detail: 'Threshold routing, regeneration, abandonment' },
  { id: 7, name: 'Campaign Reviewer', detail: 'Cross-asset review and forced replan' },
  { id: 8, name: 'Live graph and timeline', detail: 'Animated DAG, filterable events' },
  { id: 9, name: 'Export and polish', detail: 'Zip export, failure states, demo' },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Chorus</h1>
          <Badge variant="secondary">Phase 0</Badge>
        </div>
        <p className="text-muted-foreground text-balance">
          One long-form podcast plus a growth objective, turned into a multi-platform campaign by
          seven agents that decide what is worth making, critique their own output, and review the
          result as a portfolio.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Build progress</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {PHASES.map((phase) => (
            <div key={phase.id} className="flex items-baseline gap-3 text-sm">
              <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">
                Phase {phase.id}
              </span>
              <span className="font-medium">{phase.name}</span>
              <span className="text-muted-foreground text-xs">{phase.detail}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-sm">
        Run the app and the worker side by side: <code className="font-mono">npm run dev</code> and{' '}
        <code className="font-mono">npm run worker</code>.
      </p>
    </main>
  );
}
