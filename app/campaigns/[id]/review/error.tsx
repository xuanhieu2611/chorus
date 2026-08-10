'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 items-center px-6 py-12">
      <Card className="w-full border-destructive/40">
        <CardContent className="flex flex-col gap-4 p-6">
          <h1 className="text-lg font-semibold">The final campaign could not be rendered</h1>
          <p className="text-muted-foreground text-sm">{error.message || 'Try loading the review again.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={reset}>Try again</Button>
            <Button asChild variant="outline"><Link href="/">New campaign</Link></Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
