import { connection } from 'next/server';
import { Card, CardContent } from '@/components/ui/card';
import { NewCampaignForm } from '@/components/NewCampaignForm';
import { AGENT_ROSTER } from '@/lib/graph/view';
import { env } from '@/lib/env';

export default async function Home() {
  // Read MAX_ASSETS from the server at request time so the form and API stay
  // aligned when the same build is promoted between environments.
  await connection();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-6 py-14">
      <header className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tighter">Chorus</h1>
        <p className="text-muted-foreground text-lg leading-relaxed text-balance">
          One long-form podcast and a growth objective, turned into a multi-platform campaign by
          seven agents that decide what is worth making, critique their own output, and review the
          result as a portfolio.
        </p>
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.95fr)]">
        <Card>
          <CardContent className="pt-6">
            <NewCampaignForm maxAssets={env.maxAssets} />
          </CardContent>
        </Card>

        <section className="flex flex-col gap-4" aria-labelledby="roster-heading">
          <h2 id="roster-heading" className="text-sm font-semibold">
            Who works on it
          </h2>
          <ol className="border-border divide-border divide-y overflow-hidden rounded-xl border">
            {AGENT_ROSTER.map((agent, index) => (
              <li key={agent.key} className="bg-card flex items-baseline gap-3 px-4 py-3">
                <span className="text-muted-foreground w-4 shrink-0 font-mono text-[11px]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium">{agent.label}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{agent.role}</span>
              </li>
            ))}
          </ol>
          <p className="text-muted-foreground text-xs leading-relaxed">
            The dashboard streams every decision these agents make while the run is in flight, and
            pauses at two approval gates for you. The app and the worker are two processes: run{' '}
            <code className="font-mono">npm run dev</code> and{' '}
            <code className="font-mono">npm run worker</code> side by side, or a campaign sits
            queued forever.
          </p>
        </section>
      </div>
    </main>
  );
}
