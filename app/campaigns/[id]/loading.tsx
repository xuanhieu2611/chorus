import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="bg-muted h-4 w-32 animate-pulse rounded" />
      <Card>
        <CardHeader><div className="bg-muted h-7 w-72 animate-pulse rounded" /></CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          <div className="bg-muted h-72 animate-pulse rounded-lg" />
          <div className="bg-muted h-72 animate-pulse rounded-lg" />
        </CardContent>
      </Card>
    </main>
  );
}
