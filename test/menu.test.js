import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_BUTTONS, MENU_CANVAS, buttonAt } from '../src/xrMenu.js';
import { formatVersion } from '../src/version.js';

const v = (y) => 1 - y / MENU_CANVAS.height; // canvas y (down) -> texture v (up)

test('buttonAt maps texture coordinates (v up) to the menu buttons', () => {
  // Three buttons across the top: Exit AR, Reload, Sound; Steering and Reset in the second
  // row; Look across the third.
  assert.equal(buttonAt(0.18, v(84)), 'exit');
  assert.equal(buttonAt(0.5, v(84)), 'reload');
  assert.equal(buttonAt(0.82, v(84)), 'sound');
  assert.equal(buttonAt(0.1, v(210)), 'steering');
  assert.equal(buttonAt(0.6, v(210)), 'steering');
  assert.equal(buttonAt(0.82, v(210)), 'reset');
  assert.equal(buttonAt(0.658, v(210)), null);
  assert.equal(buttonAt(0.5, v(326)), 'look');
  assert.equal(buttonAt(0.5, v(268)), null); // between the second and third rows
  assert.equal(buttonAt(0.342, v(84)), null); // the gaps between them
  assert.equal(buttonAt(0.658, v(84)), null);
  assert.equal(buttonAt(0.5, v(152)), null); // between the rows
  assert.equal(buttonAt(0.5, v(421)), null); // the version line at the bottom
  assert.equal(buttonAt(0.01, 0.99), null); // the panel's rounded corner
});

test('every button is reachable at its centre', () => {
  for (const b of MENU_BUTTONS) {
    const u = (b.x + b.w / 2) / MENU_CANVAS.width;
    assert.equal(buttonAt(u, v(b.y + b.h / 2)), b.id);
  }
});

test('formatVersion shows date and time with seconds', () => {
  const text = formatVersion('2026-10-04T16:12:29.403Z', 'en-GB');
  assert.match(text, /^Updated 4 Oct 2026, \d{2}:12:29$/);
});
