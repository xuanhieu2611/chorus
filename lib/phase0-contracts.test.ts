import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('planning revisions and portfolio replans have separate durable counters', () => {
  const migrationsDirectory = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const migrations = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(`${migrationsDirectory}/${file}`, 'utf8'))
    .join('\n');

  assert.match(migrations, /\bplan_revision_count\b/);
  assert.match(migrations, /\bportfolio_replan_count\b/);
});

test('final approval records whether a REPLAN was overridden by a human', () => {
  const route = read('../app/api/campaigns/[id]/approve/route.ts');

  assert.match(route, /completion_mode/);
  assert.match(route, /human_override/);
  assert.match(route, /REPLAN/);
});
