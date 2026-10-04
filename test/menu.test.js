import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_BUTTONS, buttonAt } from '../src/xrMenu.js';
import { formatVersion } from '../src/version.js';

test('buttonAt maps texture coordinates (v up) to the menu buttons', () => {
  // Three buttons across the top: Exit AR, Reload, Sound.
  assert.equal(buttonAt(0.18, 0.7), 'exit');
  assert.equal(buttonAt(0.5, 0.7), 'reload');
  assert.equal(buttonAt(0.82, 0.7), 'sound');
  assert.equal(buttonAt(0.342, 0.7), null); // the gaps between them
  assert.equal(buttonAt(0.658, 0.7), null);
  assert.equal(buttonAt(0.5, 0.15), null); // the version line at the bottom
  assert.equal(buttonAt(0.01, 0.99), null); // the panel's rounded corner
});

test('every button is reachable at its centre', () => {
  for (const b of MENU_BUTTONS) {
    const u = (b.x + b.w / 2) / 640;
    const v = 1 - (b.y + b.h / 2) / 260;
    assert.equal(buttonAt(u, v), b.id);
  }
});

test('formatVersion shows date and time with seconds', () => {
  const text = formatVersion('2026-10-04T16:12:29.403Z', 'en-GB');
  assert.match(text, /^Updated 4 Oct 2026, \d{2}:12:29$/);
});
