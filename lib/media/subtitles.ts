import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Word } from '@/lib/media/transcribe';

export interface SubtitleInput {
  words: Word[];
  clipStart: number;
  clipEnd: number;
  assPath: string;
  hook?: string;
  wordsPerCard?: number;
}

/**
 * Word timestamps to ASS. Each 2 to 4 word card is redrawn as the spoken word
 * changes, so the current word is amber while its neighbours stay white.
 */
export async function generateAssSubtitles(input: SubtitleInput): Promise<string> {
  const wordsPerCard = Math.max(2, Math.min(4, input.wordsPerCard ?? 3));
  const words = input.words.filter(
    (word) => word.e > input.clipStart && word.s < input.clipEnd && word.w.trim() !== '',
  );
  const dialogue: string[] = [];

  for (let offset = 0; offset < words.length; offset += wordsPerCard) {
    const group = words.slice(offset, offset + wordsPerCard);
    for (const [active, word] of group.entries()) {
      const start = Math.max(input.clipStart, word.s) - input.clipStart;
      const next = group[active + 1];
      const end = Math.min(input.clipEnd, next?.s ?? group[group.length - 1].e) - input.clipStart;
      if (end <= start) continue;
      const text = group
        .map((item, index) =>
          index === active
            ? `{\\c&H00D7FF&}${escapeAss(item.w)}{\\c&HFFFFFF&}`
            : escapeAss(item.w),
        )
        .join(' ');
      dialogue.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    }
  }

  if (input.hook?.trim()) {
    dialogue.unshift(
      `Dialogue: 1,0:00:00.00,${assTime(Math.min(3, input.clipEnd - input.clipStart))},Hook,,0,0,0,,${wrapHook(input.hook)}`,
    );
  }

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Caption,Inter,64,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,80,80,300,1',
    'Style: Hook,Inter,54,&H00FFFFFF,&H0000D7FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,2,0,8,90,90,150,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...dialogue,
    '',
  ].join('\n');

  await mkdir(dirname(input.assPath), { recursive: true });
  await writeFile(input.assPath, ass, 'utf8');
  return input.assPath;
}

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const centiseconds = Math.round(safe * 100);
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAss(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r?\n/g, ' ');
}

function wrapHook(value: string): string {
  const words = value.trim().split(/\s+/);
  if (words.length < 6) return escapeAss(value.trim());
  const midpoint = Math.ceil(words.length / 2);
  return `${escapeAss(words.slice(0, midpoint).join(' '))}\\N${escapeAss(words.slice(midpoint).join(' '))}`;
}
