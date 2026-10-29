// Interface habits: how someone drives the page rather than how their hand
// moves. Keyboard vs mouse, how they select text, how they scroll and read,
// where the cursor rests, and how they fill in forms.
//
// Everything is a share or a timing, so it describes the person's habits and
// says nothing about the browser, device or what they typed.

import { median, share } from './stats.js';

export const INTERACTION_FEATURE_NAMES = [
  // keyboard vs mouse
  'keyboard_nav_share', // Tab/Enter/scroll keys/shortcuts vs mouse clicks
  'clip_shortcut_share', // copy/cut/paste via shortcut vs context menu
  'field_tab_share', // moving between form fields with Tab vs clicking
  'submit_enter_share', // submitting forms with Enter vs clicking the button
  // selecting text
  'select_double_share',
  'select_triple_share',
  'select_keyboard_share', // Shift+arrows; the remainder is drag-selecting
  // scrolling and reading
  'scroll_wheel_share',
  'scroll_keyboard_share',
  'scroll_scrollbar_share',
  'scroll_burst_med', // how far one burst goes, in screen heights (log)
  'scroll_pause_med', // reading pause between bursts (log ms)
  'scroll_back_share', // share of scrolled distance that goes back up
  'scroll_cursor_moves_share', // bursts during which the mouse also moved
  // idle cursor
  'rest_x_med', // where the cursor is parked, 0..1 across the window
  'rest_y_med',
  'rest_edge_share', // parked against a window edge
  'rest_outside_share', // moved off the page while idle
  'slow_drift_share', // share of movement time spent creeping (reading along)
  // forms
  'field_forward_share', // fields filled top-to-bottom vs jumping back
  'field_ms_per_char_med', // time in a field per typed character (log)
  'correction_rate', // Backspace/Delete per typed character
  'paste_field_share', // fields filled by pasting
];

const BURST_GAP_MS = 400;
const SLOW_PX_PER_MS = 0.1;
const EDGE = 0.05;

export function interactionFeatures(events) {
  let clicks = 0, nav = 0;
  let clips = 0, clipShortcut = 0;
  let tabMoves = 0, clickMoves = 0, transitions = 0, forward = 0;
  let submits = 0, enterSubmits = 0;
  const sel = { double: 0, triple: 0, key: 0, drag: 0 };
  const scrollMethods = { wheel: 0, key: 0, bar: 0, other: 0 };
  const bursts = [];
  const rests = [];
  let movingMs = 0, slowMs = 0;
  let chars = 0, corrections = 0, filled = 0, pasted = 0;
  const msPerChar = [];

  let lastWheel = -Infinity, lastScrollKey = -Infinity, lastCm = -Infinity;
  let lastTab = -Infinity, lastClick = -Infinity, lastFieldEnter = -Infinity, lastBlur = -Infinity;
  const lastShortcut = { copy: -Infinity, cut: -Infinity, paste: -Infinity };
  let barHeld = false;
  let lastSel = null;
  let lastMove = null;
  let burst = null;
  let prevField = null;
  let span = null; // the form field currently focused
  let leftSinceMove = false;
  let pendingRest = null;

  const closeBurst = () => {
    if (!burst) return;
    const method = Object.entries(burst.methods).sort((a, b) => b[1] - a[1])[0][0];
    scrollMethods[method]++;
    bursts.push(burst);
    burst = null;
  };

  for (const e of events) {
    if (burst && e.t - burst.end > BURST_GAP_MS) closeBurst();

    switch (e.type) {
      case 'm':
        if (lastMove) {
          const dt = e.t - lastMove.t;
          const d = Math.hypot(e.x - lastMove.x, e.y - lastMove.y);
          if (dt > 0 && dt < 100 && d > 0) {
            movingMs += dt;
            if (d / dt < SLOW_PX_PER_MS) slowMs += dt;
          }
        }
        if (burst) burst.moved = true;
        lastMove = e;
        leftSinceMove = false;
        pendingRest = null;
        break;

      case 'd':
        if (e.b === 0) {
          clicks++;
          lastClick = e.t;
        }
        if (e.sb) barHeld = true;
        break;

      case 'u':
        barHeld = false;
        break;

      case 'w':
        lastWheel = e.t;
        break;

      case 'k':
        if (e.k === 'tab' || e.k === 'stab') lastTab = e.t;
        if (e.k === 'page' || (e.k === 'arrow' && !e.f)) lastScrollKey = e.t;
        if (e.k === 'enter' && e.f) lastFieldEnter = e.t;
        if (e.k.startsWith('sc:') && e.k.slice(3) in lastShortcut) lastShortcut[e.k.slice(3)] = e.t;
        if (['tab', 'stab', 'enter', 'page'].includes(e.k) || e.k.startsWith('sc:') || (e.k === 'arrow' && !e.f)) {
          nav++;
        }
        if (span && e.f) {
          if (e.k === 'c') span.chars++;
          if (e.k === 'bk' || e.k === 'del') span.corrections++;
        }
        break;

      case 'cm':
        lastCm = e.t;
        break;

      case 'clip': {
        // Only count it when we can tell how it was done; menu-bar and
        // programmatic copies are neither.
        const viaShortcut = e.t - lastShortcut[e.op] < 500;
        if (viaShortcut || e.t - lastCm < 10000) {
          clips++;
          if (viaShortcut) clipShortcut++;
        }
        if (e.op === 'paste' && span && e.f) span.pasted = true;
        break;
      }

      case 'sel':
        if (e.via === 'k') {
          if (!(lastSel?.via === 'k' && e.t - lastSel.t < 1000)) sel.key++;
        } else if (e.n >= 3) {
          // A triple click first reports itself as a double click.
          if (lastSel?.via === 'm' && lastSel.n === 2 && e.t - lastSel.t < 800) sel.double--;
          sel.triple++;
        } else if (e.n === 2) {
          sel.double++;
        } else {
          sel.drag++;
        }
        lastSel = e;
        break;

      case 's': {
        const method = barHeld ? 'bar' : e.t - lastWheel < 300 ? 'wheel' : e.t - lastScrollKey < 600 ? 'key' : 'other';
        if (!burst) {
          burst = { start: e.t, end: e.t, dist: 0, up: 0, moved: false, methods: {}, pause: NaN };
          const prev = bursts[bursts.length - 1];
          if (prev && e.t - prev.end < 60000) burst.pause = e.t - prev.end;
        }
        burst.end = e.t;
        burst.dist += Math.abs(e.d);
        if (e.d < 0) burst.up += -e.d;
        burst.methods[method] = (burst.methods[method] ?? 0) + 1;
        break;
      }

      case 'r':
        pendingRest = { x: e.nx, y: e.ny, outside: leftSinceMove };
        rests.push(pendingRest);
        break;

      case 'l':
        leftSinceMove = true;
        if (pendingRest) pendingRest.outside = true;
        break;

      case 'f':
        if (prevField !== null && e.t - lastBlur < 2000) {
          transitions++;
          if (e.i > prevField) forward++;
          if (e.t - lastTab < 150) tabMoves++;
          else if (e.t - lastClick < 500) clickMoves++;
        }
        prevField = e.i;
        span = { t: e.t, chars: 0, corrections: 0, pasted: false };
        break;

      case 'b':
        if (span) {
          if (span.chars || span.corrections || span.pasted) filled++;
          if (span.pasted) pasted++;
          else if (span.chars >= 3) msPerChar.push(Math.log((e.t - span.t) / span.chars));
          chars += span.chars;
          corrections += span.corrections;
        }
        span = null;
        lastBlur = e.t;
        break;

      case 'sub':
        submits++;
        if (e.t - lastFieldEnter < 300) enterSubmits++;
        break;
    }
  }
  closeBurst();

  const selections = sel.double + sel.triple + sel.key + sel.drag;
  const inside = rests.filter((r) => !r.outside);
  const scrolledBursts = bursts.filter((b) => b.dist > 0);
  const scrolled = scrolledBursts.reduce((s, b) => s + b.dist, 0);

  return {
    features: {
      keyboard_nav_share: share(nav, nav + clicks),
      clip_shortcut_share: share(clipShortcut, clips),
      field_tab_share: share(tabMoves, tabMoves + clickMoves),
      submit_enter_share: share(enterSubmits, submits),
      select_double_share: share(sel.double, selections),
      select_triple_share: share(sel.triple, selections),
      select_keyboard_share: share(sel.key, selections),
      scroll_wheel_share: share(scrollMethods.wheel, bursts.length),
      scroll_keyboard_share: share(scrollMethods.key, bursts.length),
      scroll_scrollbar_share: share(scrollMethods.bar, bursts.length),
      scroll_burst_med: median(scrolledBursts.map((b) => Math.log(b.dist))),
      scroll_pause_med: median(scrolledBursts.map((b) => Math.log(b.pause))),
      scroll_back_share: scrolled > 0 ? scrolledBursts.reduce((s, b) => s + b.up, 0) / scrolled : NaN,
      scroll_cursor_moves_share: share(bursts.filter((b) => b.moved).length, bursts.length),
      rest_x_med: median(inside.map((r) => r.x)),
      rest_y_med: median(inside.map((r) => r.y)),
      rest_edge_share: share(
        inside.filter((r) => r.x < EDGE || r.x > 1 - EDGE || r.y < EDGE || r.y > 1 - EDGE).length,
        inside.length,
      ),
      rest_outside_share: share(rests.length - inside.length, rests.length),
      slow_drift_share: movingMs > 0 ? slowMs / movingMs : NaN,
      field_forward_share: share(forward, transitions),
      field_ms_per_char_med: median(msPerChar),
      correction_rate: chars >= 10 ? (corrections + 0.5) / (chars + 1) : NaN,
      paste_field_share: share(pasted, filled),
    },
    counts: {
      keyboardActions: nav,
      clipboard: clips,
      selections,
      scrollBursts: bursts.length,
      rests: rests.length,
      fieldsFilled: filled,
      submits,
    },
  };
}
