# OpenMorph Pro

**Professional Shape Morphing Suite for Adobe After Effects**

A dockable ScriptUI panel that morphs any shape layer into any other — including shapes with holes, boolean operations, rectangles, ellipses, stars, and complex multi-path compositions.

---

## Features

- **Single** — morph one shape layer into another, each result on its own render layer
- **Chain** — A → B → C → D sequence on one render layer with sequential keyframes
- **Multi** — multiple independent morph pairs, each with its own render layer and timing
- **Auto Bezier Conversion** — rectangles, ellipses, and stars are converted to Bezier automatically in script (no manual "Convert to Bezier Path" needed, works in both standalone and docked-panel mode)
- **Boolean / Hole support** — shapes using Merge Paths (Exclude Intersection etc.) morph correctly using Even-Odd fill rule + collapsed dummy sub-paths. Holes stay holes throughout the morph
- **Needleman-Wunsch alignment** — dummy vertices are placed at optimal positions on the Bezier curve rather than being distributed uniformly (see credits below)
- **Arc-length redistribution** — ShapeShifter-quality vertex density as a pre-pass
- **Easy Ease / Expo / Linear** easing on all keyframes
- **Position travel** — optional null controller moves the shape from source to target position
- **Post-morph tools** — Reverse winding, Nudge start vertex, Bake null

---

## Install

**As a dockable panel (recommended):**
```
Copy "OpenMorph Pro.jsx" to:
  macOS: /Applications/Adobe After Effects [version]/Scripts/ScriptUI Panels/
  Windows: C:\Program Files\Adobe\Adobe After Effects [version]\Support Files\Scripts\ScriptUI Panels\
```
Then open via **Window → OpenMorph Pro**.

**As a standalone script:**
File → Scripts → Run Script File → select `OpenMorph Pro.jsx`

---

## How to Use

### Single Morph
1. Select source shape layer → click **▶ Set** (FROM row)
2. Select target shape layer → click **▶ Set** (TO row)
3. Click **CREATE MORPH →**

### Chain Morph (A → B → C → D)
1. Select each layer in order → **+ Add Step**
2. Set duration per step if needed
3. Click **CREATE MORPH →**

### Multi Morph (parallel independent morphs)
1. Click **+ Pair** to add a pair
2. Select the pair row, then **▶ Src** and **▶ Tgt** to assign layers
3. Set start time and duration per pair
4. Click **CREATE MORPH →**

### Supported shape types
- Any Bezier path layer
- Rectangle / Rounded Rectangle (auto-converted)
- Ellipse / Circle (auto-converted)
- Star / Polygon (auto-converted)
- Shapes with Merge Paths / boolean holes
- Multi-path compositions (SPLIT, MERGE, 1:1)

---

## Algorithm Credits

### Needleman-Wunsch Path Alignment
The vertex alignment algorithm used in this tool is directly inspired by **Alex Lockwood**'s Droidcon NYC 2017 talk  
**"Animating Vector Drawables"** and his open-source tool **ShapeShifter**:

> https://github.com/alexjlockwood/ShapeShifter

Original NW algorithm: Needleman & Wunsch, 1970 — used in bioinformatics to align DNA sequences.  
Alex Lockwood adapted it to align SVG path command sequences for optimal morph quality.  
This implementation adapts the same idea for After Effects Bezier vertex rings:

- Finds the best **cyclic rotation** of the target vertex ring first
- Runs **NW dynamic programming** to find the optimal insertion positions for dummy vertices
- Inserts dummy vertices **on the actual Bezier curve** at the correct parametric `t` — not just at midpoints

This produces far smoother morphs than uniform arc-length redistribution, especially for shapes with very different topologies (e.g. hippo → elephant from the ShapeShifter demo).

### Collapsed Dummy Sub-Path (boolean hole morphing)
The technique of using a collapsed invisible sub-path to morph shapes with holes (e.g. donut → star) so the hole appears to be "sucked into a black hole" is also from **ShapeShifter** / Alex Lockwood's talk.

### Even-Odd Fill Rule (hole rendering)
Instead of relying on After Effects' Merge Paths operator (which can break mid-morph), holes are rendered using **Even-Odd fill rule** on a single shared fill. This is the correct approach for morphing compound paths without operator artifacts.

### Bezier Ellipse Approximation
Standard cubic Bézier ellipse approximation using the magic constant:  
`k = 4*(√2−1)/3 ≈ 0.5522847498` — less than 0.03% error vs a true arc.

---

## Settings

| Setting | Description |
|---|---|
| Duration | Morph duration in seconds (0.1 – 10s) |
| Easing | Linear / Easy Ease / Expo |
| ↔ Pos | Match position — animates a null controller from source to target position |
| Auto Align | Uses Needleman-Wunsch for optimal vertex correspondence (recommended on) |
| Min Vertices | Minimum vertex count for smooth arcs (default 48) |

---

## License

MIT — free to use, modify, and distribute.  
If you build on this, please keep the ShapeShifter credits above intact.

---

## Acknowledgements

- **Alex Lockwood** — ShapeShifter, the NW path alignment idea, the collapsed dummy sub-path technique, the Even-Odd hole approach, and the Droidcon talk that explained all of it clearly
- **Nick Butcher** — icon animation advocacy and inspiration (mentioned in Alex's talk)
- **Needleman & Wunsch** — the original 1970 algorithm, now powering smoother After Effects morphs
