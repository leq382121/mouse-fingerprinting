import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionFeatures } from '../src/interaction.js';
import { FEATURE_NAMES } from '../src/features.js';

// A short scripted visit: fill a 3-field form with Tab, fix a typo, paste into
// one field, submit with Enter, copy with Ctrl+C, select by double and triple
// click, scroll by wheel and by keyboard, and park the cursor.
function visit() {
  const ev = [];
  let t = 0;
  const at = (dt, e) => ev.push({ ...e, t: (t += dt) });
  const type = (n) => { for (let i = 0; i < n; i++) at(150, { type: 'k', k: 'c', f: 1 }); };

  at(0, { type: 'm', x: 100, y: 100 });
  at(50, { type: 'd', x: 100, y: 100, b: 0 });
  at(80, { type: 'u', x: 100, y: 100, b: 0 });
  at(5, { type: 'f', i: 0 });
  type(6);
  at(100, { type: 'k', k: 'bk', f: 1 });
  type(2);
  at(100, { type: 'k', k: 'tab', f: 1 });
  at(10, { type: 'b' });
  at(10, { type: 'f', i: 1 });
  at(100, { type: 'k', k: 'sc:paste', f: 1 });
  at(5, { type: 'clip', op: 'paste', f: 1 });
  at(100, { type: 'k', k: 'tab', f: 1 });
  at(10, { type: 'b' });
  at(10, { type: 'f', i: 2 });
  type(5);
  at(100, { type: 'k', k: 'enter', f: 1 });
  at(20, { type: 'sub' });
  at(10, { type: 'b' });

  at(500, { type: 'sel', via: 'm', n: 2 });
  at(200, { type: 'sel', via: 'm', n: 3 });
  at(300, { type: 'k', k: 'sc:copy', f: 0 });
  at(5, { type: 'clip', op: 'copy', f: 0 });

  for (let i = 0; i < 5; i++) { at(40, { type: 'w' }); at(10, { type: 's', d: 0.2 }); }
  at(3000, { type: 'k', k: 'page', f: 0 });
  at(50, { type: 's', d: 0.9 });
  at(2000, { type: 'w' });
  at(10, { type: 's', d: -0.3 });

  at(100, { type: 'm', x: 1200, y: 300 });
  at(1500, { type: 'r', nx: 0.98, ny: 0.4 });
  return ev;
}

test('interaction features describe the scripted habits', () => {
  const { features: f, counts } = interactionFeatures(visit());
  assert.equal(counts.fieldsFilled, 3);
  assert.equal(counts.submits, 1);
  assert.equal(counts.selections, 1, 'double click followed by triple click is one selection');
  assert.equal(counts.scrollBursts, 3);

  assert.ok(f.field_tab_share > 0.7, 'both field changes were Tab');
  assert.ok(f.field_forward_share > 0.7);
  assert.ok(f.submit_enter_share > 0.5);
  assert.ok(f.clip_shortcut_share > 0.7);
  assert.ok(f.select_triple_share > f.select_double_share);
  assert.ok(f.paste_field_share > 0.3 && f.paste_field_share < 0.7);
  assert.ok(Math.abs(f.correction_rate - 1.5 / 14) < 1e-9);
  assert.ok(f.scroll_wheel_share > f.scroll_keyboard_share && f.scroll_keyboard_share > 0.2);
  assert.ok(Math.abs(f.scroll_back_share - 0.3 / 2.2) < 1e-9);
  assert.equal(f.rest_x_med, 0.98);
  assert.ok(f.rest_edge_share > 0.5);
});

test('no keys, text or device properties end up in the feature names', () => {
  assert.ok(!FEATURE_NAMES.some((n) => /wheel_delta|sample_interval|screen|agent|viewport/.test(n)));
});
