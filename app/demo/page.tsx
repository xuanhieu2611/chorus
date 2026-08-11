import type { Metadata } from 'next';
import { DemoWalkthrough } from '@/components/DemoWalkthrough';

export const metadata: Metadata = {
  title: 'Zero-cost walkthrough | Chorus',
  description: 'Review the Chorus campaign flow with local mock data and no model calls.',
};

export default function DemoPage() {
  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 px-4 py-4 lg:h-dvh lg:flex-none lg:overflow-hidden xl:px-6">
      <DemoWalkthrough />
    </main>
  );
}
