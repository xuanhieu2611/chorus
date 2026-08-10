import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { NewCampaignForm } from '@/components/NewCampaignForm';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Chorus</h1>
          <Badge variant="secondary">Phase 1</Badge>
        </div>
        <p className="text-muted-foreground text-balance">
          One long-form podcast plus a growth objective, turned into a multi-platform campaign by
          seven agents that decide what is worth making, critique their own output, and review the
          result as a portfolio.
        </p>
      </header>

      <Card>
        <CardContent className="pt-6">
          <NewCampaignForm />
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-sm">
        The app and the worker are two processes. Run <code className="font-mono">npm run dev</code>{' '}
        and <code className="font-mono">npm run worker</code> side by side, or a campaign will sit
        queued forever. Ingest and transcription run today; the agents arrive in Phase 2 onward.
      </p>
    </main>
  );
}
