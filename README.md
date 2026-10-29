# mouse-fingerprinting

Behavioural fingerprinting from how people use a web page. It records mouse movement and
interface habits in the browser: keyboard vs mouse, text selection, scrolling, where the
cursor rests, and form filling. It turns them into a 56-number feature vector and matches
that vector against enrolled profiles.

Only behaviour goes into the fingerprint. It contains nothing about the browser, device,
screen or operating system.

No dependencies. Runs in the browser and in Node.

## Quick start

```sh
npm test        # runs the pipeline on simulated users
npm run demo    # then open http://localhost:8080/demo/
```

In the demo, click about 60 dots, read and select some of the text, fill in the form, and
save it all under a name. Do the same for a second person. Then clear the sample, repeat,
and press **Who is this?**

## Usage

```js
import { BehaviourCollector, extractFingerprint, fingerprintWindows, ProfileStore } from 'mouse-fingerprinting';

const collector = new BehaviourCollector().start();   // listens on window

// Enroll: split one long session into several samples
const store = new ProfileStore();
for (const fp of fingerprintWindows(collector.drain())) store.enroll('alice', fp);

// Later: who is this? (1:N)
const { best, distance, ranking } = store.identify(extractFingerprint(collector.drain()));

// Or: is this really alice? (1:1, usually the more reliable question)
const { match } = store.verify('alice', extractFingerprint(collector.drain()));

// Persist profiles
const restored = ProfileStore.fromJSON(JSON.parse(JSON.stringify(store)));
```

In production you would normally send `collector.drain()` batches to a server and run
`features.js` and `matcher.js` there. Both are plain ES modules.

## What is recorded

`BehaviourCollector` keeps a compact event log. The event shapes are listed at the top of
`src/collector.js`. It deliberately does **not** record:

- which keys or characters were typed (printable keys all become one class, `c`)
- anything at all from password fields
- selected, copied or pasted text
- field names or values, or URLs
- browser, device or screen properties: user agent, screen or window size, wheel delta
  sizes, or whether shortcuts used Ctrl or Cmd

Cursor rest positions are stored as fractions of the window (0..1), never in pixels
together with the window size.

## What it measures

### Mouse movement

The event stream is split into **strokes**, which are runs of movement separated by
pauses longer than 250 ms or by a click. For each stroke it measures:

| Feature | What it captures |
|---|---|
| duration, mean/peak speed | how fast the person moves |
| peak acceleration/deceleration, jerk | how smooth or abrupt the motion is |
| straightness, curvature, max deviation | whether the path is a straight line or an arc (wrist and elbow pivot) |
| tPeak | where in the movement the speed peaks (early burst vs. slow approach) |
| submovements | how many corrective sub-movements happen on the way to the target |
| overshoot | how far past the target the cursor goes before coming back |

Each of these becomes a median and an IQR over the session, which are robust to outliers.
The vector also has session-level features:

- **Fitts' law fit**: `duration = a + b·log2(1 + distance)`. The intercept and slope are
  quite personal and depend much less on page layout than raw speeds do.
- **Speed scaling**: how peak speed grows with distance.
- **Clicks**: how long the button is held, and how long the cursor rests before clicking.

### Interface habits (`src/interaction.js`)

| Group | Features |
|---|---|
| Keyboard vs mouse | share of actions done with Tab/Enter/scroll keys/shortcuts instead of clicks; copy/paste via shortcut vs context menu; Tab vs click between form fields; Enter vs clicking to submit |
| Selecting text | share of selections made by double-click, triple-click, or Shift+arrows (the rest are drag-selects) |
| Scrolling and reading | wheel vs keyboard vs scrollbar; how far one scroll burst goes; reading pause between bursts; how much scrolling goes back up; whether the mouse moves while scrolling |
| Idle cursor | where the cursor is parked; how often it rests against a window edge or off the page; how much movement is slow creeping (following text while reading) |
| Forms | top-to-bottom vs jumping back; time per typed character; Backspace/Delete per character; fields filled by pasting |

Most of these are shares, smoothed so that a single observation doesn't read as 0% or
100%. A feature is left empty when the behaviour never happened in the sample, such as
no forms on the page, and the matcher skips empty features.

Matching uses a weighted, scaled Manhattan distance: `Σ w·|x − μ| / σ`, divided by `Σ w`.
Each profile's σ is shrunk towards the population σ, so profiles with only a few samples
are not overconfident. The weights `w` are Fisher ratios learned from the enrolled
profiles: how much people differ on a feature compared with how much one person varies.
Noisy and layout-dependent features end up with low weights. The ratios are square-rooted
and capped, so that no single feature can dominate. Smaller distances are closer, and
`DEFAULT_THRESHOLD` (0.85) is the cutoff for calling it a match.

Passing an array of fingerprints, such as consecutive windows from one visit, to
`identify()` or `verify()` averages their distances. That is more reliable than a
single window.

## How well it works

`npm run bench` enrolls each simulated user from one session and probes with a different
session. In the `hard` scenario there are 50 users, 15-stroke samples, and ±15%
day-to-day drift in each user's habits:

| hard scenario, mouse movement only | top-1 | EER |
|---|---|---|
| single sample | 74.4% | 7.4% |
| 3 samples combined per probe | 77.7% | 6.9% |

Earlier versions also used device features (polling rate, wheel hardware) and reached
about 90%. Those were removed so that only behaviour is used. The simulator does not
model interface habits, so the benchmark measures mouse movement alone. The interface
features are covered by unit tests, but their contribution to accuracy can only be
measured on real recordings.

**These numbers only show that the pipeline works, not how it will do on real people.**
The simulated users are cleaner and more distinct than real ones. Published results for
mouse dynamics on real data are noticeably weaker, with equal error rates often in the
5–20% range, depending on how much movement each sample has. Some practical points:

- More data per sample helps a lot. Twenty strokes is a minimum, and 50+ is much better.
- The same person on a different device (mouse vs. trackpad) moves differently, so their
  mouse features won't match well. Their interface habits mostly carry over.
- Page layout affects the raw speed and duration features. Enroll and identify on the
  same kind of page, or rely more on the Fitts and click features.
- Verification ("is this the account owner?") is much more reliable than open-set
  identification ("which of 10,000 people is this?").
- Recalibrate `DEFAULT_THRESHOLD` on real traffic. Record labelled sessions, check the
  genuine and impostor distance distributions, and pick the false-accept/false-reject
  tradeoff you want.

Good fits: bot detection (scripted cursors have tell-tale straightness, jerk and timing),
account-takeover signals, and spotting shared accounts. Treat it as one risk signal among
several, not as proof of identity.

## Privacy note

Under GDPR, data from "behavioural characteristics" that allows or confirms the unique
identification of a person is biometric data (Art. 4(14)). Processing it for that purpose
is special-category processing (Art. 9), which usually needs explicit consent or another
Art. 9 basis, and probably a DPIA. Uses like fraud and bot detection may have a different
legal basis than identifying visitors. Check with whoever handles data protection before
running this on real users.

Leaving browser and device data out is good data minimisation. It does not make this
"just a prediction" in the legal sense. The biometric definition covers behaviour that
allows identification, and it doesn't matter that the match is probabilistic.
