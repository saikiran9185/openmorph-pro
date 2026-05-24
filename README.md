# OpenMorph Pro

**One-button morph rig for Adobe After Effects.**

A dockable ScriptUI panel that morphs any two (or more) layers into each other — works on shape layers (precise vector path morphing) and on anything else (text, images, footage, precomps) via an animation rig. Single button, modifier-key alternates, live controller for tuning.

---

## What's New in v3.0

v3 collapses the old Single / Chain / Multi tabs into a single workflow inspired by Super Morphings:

- **One button.** Select layers in the timeline → click **MORPH IT**.
- **Auto-detection.** If everything selected is a shape layer, the path engine runs. If anything else is in the selection, the rig engine runs.
- **Modifier keys.** Shift = pair morph. Alt = no anticipation hold.
- **Live controller.** A single `OpenMorph Controller` null in the comp exposes Amplitude / Frequency / Decay sliders for tuning the elastic bounce after the rig is built.
- **Utilities.** Trails and Slice buttons.

The v2 path engine is fully preserved underneath — Bezier alignment, Needleman-Wunsch vertex matching, collapsed-dummy hole morphing, even-odd fill, post-morph fixes — all still there. v3 just gives it a faster way in.

---

## Install

**As a dockable panel (recommended):**
```
Copy "OpenMorph Pro.jsx" to:
  macOS:   /Applications/Adobe After Effects [version]/Scripts/ScriptUI Panels/
  Windows: C:\Program Files\Adobe\Adobe After Effects [version]\Support Files\Scripts\ScriptUI Panels\
```
Then open via **Window → OpenMorph Pro**.

**As a standalone script:**
File → Scripts → Run Script File → select `OpenMorph Pro.jsx`.

First time: enable Preferences → Scripting & Expressions → *Allow Scripts to Write Files and Access Network*.

---

## How to Use

### Morphing

Select 2 or more layers. The **last selected layer is the target**; everything else flies into it. Click **MORPH IT**.

| Selection | Modifier | What happens |
|---|---|---|
| 2 shape layers | — | Vector path morph A → B (one render layer + null controller) |
| 3+ shape layers | — | Error: path morph requires exactly 2 shapes |
| Any non-shape in selection | — | Rig morph — all sources fly into the last with anticipation + elastic |
| 2+ layers | **Alt** | Rig morph without anticipation hold (straight movement, still elastic) |
| 2, 4, 6… layers | **Shift** | Pair morph — pairs (0,1), (2,3), (4,5) morph independently |
| 2, 4, 6… layers | **Shift + Alt** | Pair morph without anticipation |

### Trails

Select any animated layer (rigged or hand-keyframed) → click **Trails**. Generates a shape layer with N expression-driven echoes that sample the source's position at `time - i × offset`. The trail layer carries its own controllers:

- **Trail Color** — fill color for all echoes
- **Trail Count** — how many echoes are visible (older ones fade)
- **Time Offset** — gap between echoes, in frames
- **Random Spread** — per-echo random position jitter
- **Random Seed** — change for a different jitter pattern

### Slice

Select 1+ layers → click **Slice** → enter N. Each selected layer is hidden, then duplicated N times with rectangular masks cutting it into N vertical strips. Each strip is now an independent layer you can morph, animate, or stagger.

### Post-Morph Utilities (path-engine only)

Small buttons at the bottom of the panel — operate on already-built shape morphs:

- **Fix Bool** — re-align vertex order on N→M morphs that look exploded
- **Reverse** — flip target path vertex order if the morph rotates the wrong way
- **Nudge** — shift start vertex by +1 to fix tangled interpolation
- **Bake** — bake null controller values onto the render layer for self-contained export

---

## Tuning the Rig

After running a rig morph, the comp gets an `OpenMorph Controller` null (green, guide layer). Its three sliders adjust **every** rigged layer's elastic bounce in real time:

| Slider | What it controls |
|---|---|
| Amplitude | Bounce magnitude (percent) |
| Frequency | Oscillations per second after the layer lands |
| Decay | How quickly the bounce damps (higher = damps faster) |

For deeper tweaking, edit the position/scale/rotation keyframes directly — the rig produces standard AE keys (3 keys with anticipation, 2 without), each with normal temporal ease.

---

## Supported Layer Types

**Path engine** (vector path morph):
- Any Bezier path layer
- Rectangle / Rounded Rectangle (auto-converted)
- Ellipse / Circle (auto-converted)
- Star / Polygon (auto-converted)
- Shapes with Merge Paths / boolean holes
- Multi-path compositions (SPLIT, MERGE, 1:1)

**Rig engine** (animation rig):
- Text layers
- Footage / image layers
- Precomp layers
- Mixed selections (anything + anything)
- Shape layers when you want elastic motion rather than path interpolation

---

## Algorithm Credits

### Needleman-Wunsch Path Alignment
The vertex alignment algorithm used in the path engine is directly inspired by **Alex Lockwood**'s Droidcon NYC 2017 talk **"Animating Vector Drawables"** and his open-source tool **ShapeShifter**:

> https://github.com/alexjlockwood/ShapeShifter

Original NW algorithm: Needleman & Wunsch, 1970 — used in bioinformatics to align DNA sequences. Alex Lockwood adapted it to align SVG path command sequences for optimal morph quality. This implementation adapts the same idea for After Effects Bezier vertex rings:

- Finds the best **cyclic rotation** of the target vertex ring first
- Runs **NW dynamic programming** to find the optimal insertion positions for dummy vertices
- Inserts dummy vertices **on the actual Bezier curve** at the correct parametric `t` — not just at midpoints

### Collapsed Dummy Sub-Path (boolean hole morphing)
The technique of using a collapsed invisible sub-path to morph shapes with holes (e.g. donut → star) so the hole appears to be "sucked into a black hole" is also from **ShapeShifter** / Alex Lockwood's talk.

### Even-Odd Fill Rule (hole rendering)
Holes are rendered using **Even-Odd fill rule** on a single shared fill instead of After Effects' Merge Paths operator (which can break mid-morph).

### Bezier Ellipse Approximation
Standard cubic Bézier ellipse approximation using the magic constant `k = 4·(√2−1)/3 ≈ 0.5522847498` — less than 0.03% error vs a true arc.

### Rig Technique
The anticipation + opacity handoff + elastic overshoot rig used by the v3 rig engine follows the approach pioneered by **Super Morphings** (Motion Design School / Michael Ugliffe / Yaroslav Kononov). The implementation here is original code that reproduces the technique; no Super Morphings source or assets are included.

---

## v3.0 Limitations

- Rig morph assumes unparented layers — parented sources will land at the wrong position. Workaround: pre-comp the parent rig first.
- Slice currently does vertical strips only.
- Trails assumes the source layer has no parent (uses raw `transform.position`, not `toComp`).
- Path engine inherits all v2 caveats: 3D Z is ignored, skew is dropped.

---

## License

MIT — free to use, modify, and distribute.
If you build on this, please keep the ShapeShifter credits above intact.

---

## Acknowledgements

- **Alex Lockwood** — ShapeShifter, the NW path alignment idea, the collapsed dummy sub-path technique, the Even-Odd hole approach, and the Droidcon talk that explained all of it clearly
- **Nick Butcher** — icon animation advocacy and inspiration (mentioned in Alex's talk)
- **Needleman & Wunsch** — the original 1970 algorithm, now powering smoother After Effects morphs
- **Motion Design School** (Michael Ugliffe, Yaroslav Kononov) — the Super Morphings tutorial that inspired the v3 single-button workflow and the rig morph technique
