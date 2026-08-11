import { connection } from 'next/server';
import Link from 'next/link';
import { NewCampaignForm } from '@/components/NewCampaignForm';
import { Button } from '@/components/ui/button';
import { env } from '@/lib/env';

export default async function Home() {
  await connection();

  return (
    <main className="home-shell mx-auto grid min-h-dvh w-full max-w-[1500px] px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(26rem,0.72fr)] lg:gap-12 xl:px-8">
      <section className="flex min-h-0 flex-col">
        <header className="flex items-center justify-between">
          <div className="chorus-wordmark text-base">
            <span className="chorus-glyph" aria-hidden><i /><i /><i /></span>
            <span>chorus</span>
          </div>
          <span className="text-muted-foreground hidden font-mono text-[9px] uppercase tracking-[0.18em] sm:block">
            agentic content studio
          </span>
        </header>

        <div className="flex flex-1 flex-col justify-center py-16 lg:py-8">
          <p className="text-state-active mb-5 text-[10px] font-semibold uppercase tracking-[0.22em]">
            One source / full campaign
          </p>
          <h1 className="max-w-3xl text-[clamp(3.1rem,6vw,6.6rem)] font-semibold leading-[0.88] tracking-[-0.07em] text-balance">
            Seven agents.<br />One point of view.
          </h1>
          <p className="text-muted-foreground mt-7 max-w-[32rem] text-base leading-7 text-pretty">
            Drop in a podcast. Chorus finds the signal, plans the campaign, creates every asset, and critiques the set before anything ships.
          </p>

          <div className="mt-10 flex max-w-2xl items-center gap-2" aria-label="Campaign workflow">
            {['Understand', 'Strategize', 'Create', 'Critique', 'Ship'].map((phase, index) => (
              <div key={phase} className="home-phase">
                <span>0{index + 1}</span>
                <strong>{phase}</strong>
              </div>
            ))}
          </div>
        </div>

        <footer className="text-muted-foreground flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.14em]">
          <span>Human judgment stays in the loop</span>
          <span className="hidden sm:block">Live graph / grounded outputs</span>
        </footer>
      </section>

      <section className="flex items-center py-12 lg:py-0" aria-labelledby="new-campaign-heading">
        <div className="launch-panel w-full p-5 sm:p-6">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-[0.18em]">New campaign</p>
              <h2 id="new-campaign-heading" className="mt-2 text-xl font-semibold tracking-[-0.035em]">Give the agents a brief</h2>
            </div>
            <span className="launch-status"><i /> ready</span>
          </div>
          <NewCampaignForm maxAssets={env.maxAssets} />
          <div className="mt-5 flex items-center gap-3 border-t border-border pt-5">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">Review the full product first</p>
              <p className="text-muted-foreground mt-1 text-[10px] leading-4">Local mock data. No upload, worker, transcription, or model calls.</p>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/demo">Open walkthrough</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
