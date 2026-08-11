import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from './env';

test('maxAssets applies the six-asset MVP ceiling and respects lower configuration', () => {
  const original = process.env.MAX_ASSETS;

  try {
    process.env.MAX_ASSETS = '12';
    assert.equal(env.maxAssets, 6);

    process.env.MAX_ASSETS = '4';
    assert.equal(env.maxAssets, 4);

    delete process.env.MAX_ASSETS;
    assert.equal(env.maxAssets, 6);
  } finally {
    if (original === undefined) delete process.env.MAX_ASSETS;
    else process.env.MAX_ASSETS = original;
  }
});

test('maxAssets rejects invalid configuration', () => {
  const original = process.env.MAX_ASSETS;

  try {
    process.env.MAX_ASSETS = '0';
    assert.throws(() => env.maxAssets, /MAX_ASSETS must be a positive integer/);
  } finally {
    if (original === undefined) delete process.env.MAX_ASSETS;
    else process.env.MAX_ASSETS = original;
  }
});
