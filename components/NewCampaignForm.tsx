'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'x', label: 'X' },
  { id: 'linkedin', label: 'LinkedIn' },
] as const;

type Phase = 'idle' | 'uploading' | 'creating';

/**
 * Upload plus a growth objective. One primary button.
 *
 * The file goes up as a raw body over XHR rather than through `fetch`, for one
 * reason: a 90 minute recording is 1 to 3 GB and `fetch` reports no upload
 * progress. A multi-minute upload with no progress bar reads as a hung page.
 */
export function NewCampaignForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== 'idle';

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError('Choose a podcast file.');

    const goal = String(form.get('goal') ?? '').trim();
    if (goal.length < 10) return setError('Describe the growth objective in a sentence or more.');

    try {
      setPhase('uploading');
      setPercent(0);
      const { upload_token } = await uploadFile(file, setPercent);

      setPhase('creating');
      const platforms = PLATFORMS.map((p) => p.id).filter((id) => form.get(`platform:${id}`));

      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          upload_token,
          goal,
          title: text(form, 'title'),
          audience: text(form, 'audience'),
          brand_voice: text(form, 'brand_voice'),
          platforms: platforms.length > 0 ? platforms : undefined,
          max_assets: number(form, 'max_assets'),
          max_video_seconds: number(form, 'max_video_seconds'),
        }),
      });

      const payload = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error ?? 'Could not create campaign.');

      router.push(`/campaigns/${payload.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('idle');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="file">Podcast episode</Label>
        <Input
          id="file"
          name="file"
          type="file"
          ref={fileRef}
          disabled={busy}
          accept=".mp4,.mov,.m4v,.mkv,.webm,.mp3,.m4a,.wav,.aac,.flac,.ogg"
        />
        <p className="text-muted-foreground text-xs">
          Video or audio. An audio-only source still produces postable clips, as caption cards
          rather than talking-head crops.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="goal">Growth objective</Label>
        <Textarea
          id="goal"
          name="goal"
          rows={3}
          disabled={busy}
          placeholder="Grow a developer audience on TikTok and LinkedIn by showing that we understand the day-to-day problems of shipping AI features."
        />
        <p className="text-muted-foreground text-xs">
          Every agent optimizes against this sentence, so be specific about who and what for.
        </p>
      </div>

      <details className="group border-border rounded-lg border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium select-none">
          Campaign settings
        </summary>

        <div className="mt-4 flex flex-col gap-4">
          <Field name="title" label="Title" placeholder="Optional. Defaults to the file name." disabled={busy} />
          <Field
            name="audience"
            label="Audience"
            placeholder="Senior engineers evaluating AI tooling."
            disabled={busy}
          />
          <Field
            name="brand_voice"
            label="Brand voice"
            placeholder="Direct, specific, allergic to hype."
            disabled={busy}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Platforms</legend>
            <div className="flex gap-4">
              {PLATFORMS.map((platform) => (
                <label key={platform.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`platform:${platform.id}`}
                    defaultChecked
                    disabled={busy}
                    className="accent-foreground size-4"
                  />
                  {platform.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="max_assets">Max assets</Label>
              <Input id="max_assets" name="max_assets" type="number" min={1} max={12} defaultValue={6} disabled={busy} />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="max_video_seconds">Max clip seconds</Label>
              <Input
                id="max_video_seconds"
                name="max_video_seconds"
                type="number"
                min={15}
                max={600}
                defaultValue={120}
                disabled={busy}
              />
            </div>
          </div>
        </div>
      </details>

      {error && (
        <p className="text-destructive border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-sm">
          {error}
        </p>
      )}

      {phase === 'uploading' && (
        <div className="flex flex-col gap-1">
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-foreground h-full transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">Uploading {percent}%</p>
        </div>
      )}

      <Button type="submit" disabled={busy} size="lg">
        {phase === 'uploading' ? 'Uploading…' : phase === 'creating' ? 'Queueing…' : 'Build Campaign'}
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  disabled,
}: {
  name: string;
  label: string;
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} placeholder={placeholder} disabled={disabled} />
    </div>
  );
}

function text(form: FormData, key: string): string | undefined {
  const value = String(form.get(key) ?? '').trim();
  return value === '' ? undefined : value;
}

function number(form: FormData, key: string): number | undefined {
  const value = form.get(key);
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uploadFile(file: File, onProgress: (percent: number) => void): Promise<{ upload_token: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/upload');
    request.setRequestHeader('x-filename', encodeURIComponent(file.name).replace(/%20/g, ' '));

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };

    request.onload = () => {
      let payload: { upload_token?: string; error?: string } = {};
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        return reject(new Error(`Upload failed with status ${request.status}.`));
      }
      if (request.status >= 200 && request.status < 300 && payload.upload_token) {
        resolve({ upload_token: payload.upload_token });
      } else {
        reject(new Error(payload.error ?? `Upload failed with status ${request.status}.`));
      }
    };

    request.onerror = () => reject(new Error('Upload failed: the connection dropped.'));
    request.send(file);
  });
}
