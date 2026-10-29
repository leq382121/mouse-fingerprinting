// Browser-side capture of behaviour events. Produces a compact event log that
// features.js turns into a behavioural fingerprint.
//
// Deliberately NOT recorded: which keys or characters were typed, anything in
// password fields, selected or copied text, field names/values, URLs, and any
// browser, device or screen properties (user agent, screen/window size, wheel
// delta sizes, Ctrl vs Cmd).
//
// Event shapes (t is ms, from event.timeStamp):
//   { type: 'm', t, x, y }            pointer move (coalesced events expanded)
//   { type: 'd', t, x, y, b, sb? }    button down (sb: on a scrollbar)
//   { type: 'u', t, x, y, b }         button up
//   { type: 'w', t }                  wheel turned (no deltas)
//   { type: 's', t, d }               scrolled, in screen heights (+ is down)
//   { type: 'r', t, nx, ny }          cursor came to rest, 0..1 across the window
//   { type: 'l', t }                  pointer left the page
//   { type: 'k', t, k, f }            key class (see keyClass), f: in a form field
//   { type: 'clip', t, op, f }        copy / cut / paste happened
//   { type: 'cm', t }                 context menu opened
//   { type: 'sel', t, via, n }        text got selected (via 'm'ouse with n clicks, or 'k'eyboard)
//   { type: 'f', t, i }               form field focused (i: position in document order)
//   { type: 'b', t }                  form field blurred
//   { type: 'sub', t }                form submitted

const REST_MS = 1500;
const FIELD_SELECTOR =
  'input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ']);
const SHORTCUTS = { c: 'copy', v: 'paste', x: 'cut', a: 'all', z: 'undo', y: 'redo', f: 'find', s: 'save' };

const isField = (el) => el instanceof Element && el.matches(FIELD_SELECTOR);
const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';

// Reduces a key press to a class. Printable keys all become 'c', so the log
// never contains what was typed.
function keyClass(e, inField) {
  if (e.ctrlKey || e.metaKey) {
    // e.code keeps shortcuts layout-independent (Ctrl+C on any keyboard).
    const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : '';
    return SHORTCUTS[letter] ? `sc:${SHORTCUTS[letter]}` : 'sc:other';
  }
  if (e.key === 'Backspace') return 'bk';
  if (e.key === 'Delete') return 'del';
  if (e.key === 'Enter') return 'enter';
  if (e.key === 'Tab') return e.shiftKey ? 'stab' : 'tab';
  if (ARROWS.has(e.key)) return e.shiftKey ? 'sarrow' : 'arrow';
  if (!inField && SCROLL_KEYS.has(e.key)) return 'page';
  if (e.key.length === 1) return 'c';
  return null; // modifiers, function keys, etc.
}

function hasSelection(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      return el.selectionStart !== el.selectionEnd;
    } catch {
      return false; // input types without a text selection
    }
  }
  const s = window.getSelection();
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}

function onScrollbar(e) {
  const el = e.target;
  if (el === document.documentElement) return e.clientX >= el.clientWidth || e.clientY >= el.clientHeight;
  return (
    el instanceof Element &&
    el.scrollHeight > el.clientHeight &&
    (e.offsetX > el.clientWidth || e.offsetY > el.clientHeight)
  );
}

export class BehaviourCollector {
  constructor({ target = window, maxEvents = 50000 } = {}) {
    this.target = target;
    this.root = target === window ? document : target;
    this.maxEvents = maxEvents;
    this.events = [];
    this.running = false;
    this._scrollTop = new WeakMap();
    this._lastMove = null;
    this._restTimer = null;
    this._downAt = null;

    this._handlers = {
      pointermove: (e) => {
        if (e.pointerType !== 'mouse') return;
        // Coalesced events give the real sampling rate instead of one event
        // per animation frame, which matters for speed/jerk estimates.
        const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const c of list.length ? list : [e]) {
          this._push({ type: 'm', t: c.timeStamp, x: c.clientX, y: c.clientY });
        }
        this._lastMove = e;
        clearTimeout(this._restTimer);
        this._restTimer = setTimeout(() => this._rest(), REST_MS);
      },
      pointerdown: (e) => {
        if (e.pointerType !== 'mouse') return;
        const ev = { type: 'd', t: e.timeStamp, x: e.clientX, y: e.clientY, b: e.button };
        if (onScrollbar(e)) ev.sb = 1;
        this._push(ev);
        this._downAt = { x: e.clientX, y: e.clientY };
        this._scrollBaseline(e.target);
      },
      pointerup: (e) => {
        if (e.pointerType !== 'mouse') return;
        this._push({ type: 'u', t: e.timeStamp, x: e.clientX, y: e.clientY, b: e.button });
      },
      pointerout: (e) => {
        const to = e.relatedTarget;
        if (!to || !(this.root === document ? document.documentElement : this.root).contains(to)) {
          this._push({ type: 'l', t: e.timeStamp });
        }
      },
      mouseup: (e) => {
        const n = e.detail;
        const t = e.timeStamp;
        // A single click only selects text by dragging; otherwise any leftover
        // selection would be miscounted.
        const d = this._downAt;
        if (n <= 1 && (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3)) return;
        // Wait for the browser to apply the selection the click made.
        setTimeout(() => {
          if (hasSelection(e.target)) this._push({ type: 'sel', t, via: 'm', n });
        }, 0);
      },
      wheel: (e) => {
        this._push({ type: 'w', t: e.timeStamp });
        this._scrollBaseline(e.target);
      },
      scroll: (e) => {
        const el = e.target === document ? document.scrollingElement || document.documentElement : e.target;
        if (!(el instanceof Element) || el.clientHeight === 0) return;
        const prev = this._scrollTop.get(el);
        this._scrollTop.set(el, el.scrollTop);
        if (prev !== undefined && el.scrollTop !== prev) {
          this._push({ type: 's', t: e.timeStamp, d: (el.scrollTop - prev) / el.clientHeight });
        }
      },
      keydown: (e) => {
        this._scrollBaseline(e.target);
        if (e.repeat || isPassword(e.target)) return;
        const f = isField(e.target);
        const k = keyClass(e, f);
        if (k) this._push({ type: 'k', t: e.timeStamp, k, f: f ? 1 : 0 });
      },
      keyup: (e) => {
        const selecting = e.shiftKey && (ARROWS.has(e.key) || e.key === 'Home' || e.key === 'End');
        if (selecting && !isPassword(e.target) && hasSelection(e.target)) {
          this._push({ type: 'sel', t: e.timeStamp, via: 'k', n: 0 });
        }
      },
      copy: (e) => this._clip(e, 'copy'),
      cut: (e) => this._clip(e, 'cut'),
      paste: (e) => this._clip(e, 'paste'),
      contextmenu: (e) => this._push({ type: 'cm', t: e.timeStamp }),
      focusin: (e) => {
        if (!isField(e.target)) return;
        const i = [...this.root.querySelectorAll(FIELD_SELECTOR)].indexOf(e.target);
        this._push({ type: 'f', t: e.timeStamp, i });
      },
      focusout: (e) => {
        if (isField(e.target)) this._push({ type: 'b', t: e.timeStamp });
      },
      submit: (e) => this._push({ type: 'sub', t: e.timeStamp }),
    };
  }

  start() {
    if (this.running) return this;
    this._scrollBaseline(document.scrollingElement);
    const opts = { capture: true, passive: true };
    for (const [name, fn] of Object.entries(this._handlers)) this.target.addEventListener(name, fn, opts);
    this.running = true;
    return this;
  }

  stop() {
    for (const [name, fn] of Object.entries(this._handlers)) {
      this.target.removeEventListener(name, fn, { capture: true });
    }
    clearTimeout(this._restTimer);
    this.running = false;
    return this;
  }

  // Returns the collected events and clears the buffer (e.g. before sending
  // a batch to a server).
  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  clear() {
    this.events = [];
  }

  // A scroll event only says where an element is now, so remember where every
  // scrollable ancestor was when the wheel/key/click that will scroll it
  // happened. Otherwise the first scroll of each area would be lost.
  _scrollBaseline(el) {
    for (let n = el instanceof Element ? el : null; n; n = n.parentElement) {
      if (!this._scrollTop.has(n) && n.scrollHeight > n.clientHeight) this._scrollTop.set(n, n.scrollTop);
    }
    const root = document.scrollingElement;
    if (root && !this._scrollTop.has(root)) this._scrollTop.set(root, root.scrollTop);
  }

  // Only the position relative to the window is kept, not the window size.
  _rest() {
    const e = this._lastMove;
    if (!e || !innerWidth || !innerHeight) return;
    this._push({ type: 'r', t: e.timeStamp + REST_MS, nx: e.clientX / innerWidth, ny: e.clientY / innerHeight });
  }

  _clip(e, op) {
    if (isPassword(e.target)) return;
    this._push({ type: 'clip', t: e.timeStamp, op, f: isField(e.target) ? 1 : 0 });
  }

  _push(ev) {
    this.events.push(ev);
    // Trim in chunks so we are not shifting the array on every event.
    if (this.events.length > this.maxEvents * 1.1) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

// Earlier name, kept so existing imports keep working.
export const MouseCollector = BehaviourCollector;
