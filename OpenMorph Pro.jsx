// =============================================================================
//  OpenMorph Pro.jsx  —  Professional Shape Morphing Suite for After Effects
//  Version 2.0  |  Dockable panel or floating palette
//
//  MODES
//    Single  — one shape layer into another, each morph gets its own render layer
//    Chain   — A→B→C→D sequence on one render layer with sequential keyframes
//    Multi   — multiple independent morph pairs, each with its own render layer
//
//  SUPPORTS
//    • 1 path  → 1 path   (standard)
//    • 1 path  → N paths  (SPLIT — source duplicates to fill targets)
//    • N paths → 1 path   (MERGE — all sources converge to single target)
//    • N paths → M paths  (mixed split/merge per index)
//    • Circle → Char → Circle chains
//    • Screen → Building → Building 2 chains
//    • Multi-group → single path
//    • Single path → multi-group
//
//  INSTALL
//    Copy to: .../Adobe After Effects [ver]/Scripts/ScriptUI Panels/
//    Then open via Window menu (dockable).  Or: File › Scripts › Run Script File…
// =============================================================================

(function (thisObj) {

    // =========================================================================
    //  CONSTANTS
    // =========================================================================
    var VERSION = "2.0";
    var LBL_GREEN = 9;    // AE layer label: Lime  (source layer)
    var LBL_ORANGE = 11;   // AE layer label: Peach (target layer)
    var LBL_RENDER = 10;   // AE layer label: Tan   (render output)
    var LBL_CHAIN = 6;    // AE layer label: Blue  (chain layers)
    var LBL_NULL = 12;   // AE layer label: Violet(null controllers)

    // =========================================================================
    //  SESSION
    // =========================================================================
    var SESSION = {
        renderCount: 0,       // increments per morph op → unique layer names
        mode: "single" // "single" | "chain" | "multi"
    };

    // Shared settings (all modes read from here)
    var CFG = {
        duration: 1.5,
        easing: 33,    // 0 = Linear, 33 = Easy Ease, 90 = Expo
        autoAlign: true,
        matchPosition: true,
        vertexOffset: 0,
        minVertices: 48,
        precision: 20
    };

    // Per-mode state ──────────────────────────────────────────────────────────
    var SINGLE = { srcLayer: null, tgtLayer: null, srcPaths: [], tgtPaths: [] };

    // CHAIN  – ordered list of steps
    //   step: { layer, paths, label, duration }
    var CHAIN = { steps: [] };

    // MULTI  – list of independent morph pairs
    //   pair: { srcLayer, tgtLayer, srcPaths, tgtPaths, startSec, duration }
    var MULTI = { pairs: [] };

    // =========================================================================
    //  MATH  (arc-length Bezier — ShapeShifter quality)
    // =========================================================================
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpPt(p, q, t) { return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]; }
    function dist(p, q) { var dx = q[0] - p[0], dy = q[1] - p[1]; return Math.sqrt(dx * dx + dy * dy); }

    function bezierPt(P0, P1, P2, P3, t) {
        var Q0 = lerpPt(P0, P1, t), Q1 = lerpPt(P1, P2, t), Q2 = lerpPt(P2, P3, t);
        return lerpPt(lerpPt(Q0, Q1, t), lerpPt(Q1, Q2, t), t);
    }

    function bezierTangent(P0, P1, P2, P3, t) {
        var mt = 1 - t;
        return [
            3 * mt * mt * (P1[0] - P0[0]) + 6 * mt * t * (P2[0] - P1[0]) + 3 * t * t * (P3[0] - P2[0]),
            3 * mt * mt * (P1[1] - P0[1]) + 6 * mt * t * (P2[1] - P1[1]) + 3 * t * t * (P3[1] - P2[1])
        ];
    }

    function segLen(P0, P1, P2, P3) {
        var len = 0, prev = P0;
        for (var i = 1; i <= CFG.precision; i++) {
            var pt = bezierPt(P0, P1, P2, P3, i / CFG.precision);
            len += dist(prev, pt); prev = pt;
        }
        return len;
    }

    function signedArea(p) {
        var area = 0, n = p.vertices.length;
        for (var i = 0; i < n; i++) {
            var v1 = p.vertices[i], v2 = p.vertices[(i + 1) % n];
            area += v1[0] * v2[1] - v2[0] * v1[1];
        }
        return area / 2;
    }

    // =========================================================================
    //  PATH OPERATIONS
    // =========================================================================
    function clonePath(p) {
        var v = [], i = [], o = [];
        for (var k = 0; k < p.vertices.length; k++) {
            v.push([p.vertices[k][0], p.vertices[k][1]]);
            i.push([p.inTangents[k][0], p.inTangents[k][1]]);
            o.push([p.outTangents[k][0], p.outTangents[k][1]]);
        }
        return { vertices: v, inTangents: i, outTangents: o, closed: p.closed };
    }

    function aeShape(p) {
        var s = new Shape();
        s.vertices = p.vertices; s.inTangents = p.inTangents;
        s.outTangents = p.outTangents; s.closed = p.closed;
        return s;
    }

    // Arc-length redistribution: add vertices until we reach targetCount
    function normalizePath(pd, targetCount) {
        var n = pd.vertices.length, closed = pd.closed;
        // Guard: degenerate paths (0 or 1 vertex) cannot be subdivided — return as-is
        if (n < 2) return clonePath(pd);
        var segCount = closed ? n : n - 1;
        if (n >= targetCount) return clonePath(pd);

        var lengths = [], totalLen = 0;
        for (var i = 0; i < segCount; i++) {
            var nxt = (i + 1) % n;
            var cp1 = [pd.vertices[i][0] + pd.outTangents[i][0], pd.vertices[i][1] + pd.outTangents[i][1]];
            var cp2 = [pd.vertices[nxt][0] + pd.inTangents[nxt][0], pd.vertices[nxt][1] + pd.inTangents[nxt][1]];
            var l = segLen(pd.vertices[i], cp1, cp2, pd.vertices[nxt]);
            lengths.push(l); totalLen += l;
        }

        var step = totalLen / targetCount, hLen = step / 3;
        var nV = [], nI = [], nO = [];
        for (var i = 0; i < targetCount; i++) {
            var targetDist = (i / targetCount) * totalLen;
            var acc = 0, sIdx = 0;
            while (sIdx < segCount - 1 && acc + lengths[sIdx] < targetDist) { acc += lengths[sIdx]; sIdx++; }
            var lT = lengths[sIdx] === 0 ? 0 : (targetDist - acc) / lengths[sIdx];
            var nxt = (sIdx + 1) % n;
            var cp1 = [pd.vertices[sIdx][0] + pd.outTangents[sIdx][0], pd.vertices[sIdx][1] + pd.outTangents[sIdx][1]];
            var cp2 = [pd.vertices[nxt][0] + pd.inTangents[nxt][0], pd.vertices[nxt][1] + pd.inTangents[nxt][1]];
            var v = bezierPt(pd.vertices[sIdx], cp1, cp2, pd.vertices[nxt], lT);
            var dv = bezierTangent(pd.vertices[sIdx], cp1, cp2, pd.vertices[nxt], lT);
            var dl = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1]);
            var ux = dl === 0 ? 0 : dv[0] / dl, uy = dl === 0 ? 0 : dv[1] / dl;
            nV.push(v);
            nI.push([-ux * hLen, -uy * hLen]);
            nO.push([ux * hLen, uy * hLen]);
        }
        return { vertices: nV, inTangents: nI, outTangents: nO, closed: closed };
    }

    function rotatePath(p, offset) {
        var n = p.vertices.length;
        // Guard: fewer than 2 vertices means nothing to rotate
        if (n < 2 || offset === 0) return clonePath(p);
        offset = ((offset % n) + n) % n;
        var d = clonePath(p);
        d.vertices = d.vertices.slice(offset).concat(d.vertices.slice(0, offset));
        d.inTangents = d.inTangents.slice(offset).concat(d.inTangents.slice(0, offset));
        d.outTangents = d.outTangents.slice(offset).concat(d.outTangents.slice(0, offset));
        return d;
    }

    function reversePath(p) {
        var n = p.vertices.length, d = clonePath(p);
        d.vertices = []; d.inTangents = []; d.outTangents = [];
        for (var i = n - 1; i >= 0; i--) {
            d.vertices.push(p.vertices[i]);
            d.inTangents.push([-p.outTangents[i][0], -p.outTangents[i][1]]);
            d.outTangents.push([-p.inTangents[i][0], -p.inTangents[i][1]]);
        }
        return d;
    }

    // Rotate target vertex ring to minimise total travel (no crossing / spinning)
    function alignPaths(src, tgt) {
        var n = tgt.vertices.length, best = Infinity, bestOff = 0;
        
        // Step-limiter: limits loops for complex shapes to avoid freezing
        var step = Math.max(1, Math.floor(n / 60));
        var iStep = Math.max(1, Math.floor(n / 60));
        
        for (var off = 0; off < n; off += step) {
            var score = 0;
            for (var i = 0; i < n; i += iStep) {
                var dx = src.vertices[i][0] - tgt.vertices[(i + off) % n][0];
                var dy = src.vertices[i][1] - tgt.vertices[(i + off) % n][1];
                score += dx * dx + dy * dy;
            }
            if (score < best) { best = score; bestOff = off; }
        }
        
        // Fine-tune search around best offset if stepping occurred
        if (step > 1) {
            for (var k = -step; k <= step; k++) {
                var off = (bestOff + k + n) % n;
                var score = 0;
                for (var i = 0; i < n; i += iStep) {
                    var dx = src.vertices[i][0] - tgt.vertices[(i + off) % n][0];
                    var dy = src.vertices[i][1] - tgt.vertices[(i + off) % n][1];
                    score += dx * dx + dy * dy;
                }
                if (score < best) { best = score; bestOff = off; }
            }
        }
        return rotatePath(tgt, bestOff);
    }

    // =========================================================================
    //  NEEDLEMAN-WUNSCH PATH ALIGNMENT
    //
    //  Adapted from the algorithm described by Alex Lockwood in his Droidcon NYC
    //  2017 talk "Animating Vector Drawables" and implemented in ShapeShifter:
    //    https://github.com/alexjlockwood/ShapeShifter
    //  Full credit to Alex Lockwood and the ShapeShifter community.
    //
    //  Original use: aligning DNA sequences in bioinformatics.
    //  Adapted use:  aligning two vertex rings so dummy points are inserted at
    //                positions that MINIMISE total travel distance — far smarter
    //                than uniform arc-length redistribution.
    //
    //  The algorithm:
    //    1. Find the best cyclic rotation of the longer path (same as alignPaths).
    //    2. Build an (n+1)×(m+1) DP table where each cell scores matching
    //       shorter[i] ↔ longer[j] vs inserting a gap (dummy vertex).
    //    3. Backtrack to produce the optimal alignment.
    //    4. Where there is a gap in the shorter path, insert a dummy vertex
    //       interpolated ON the original Bezier curve (not just at midpoints).
    //  Result: both paths have the same vertex count with optimal correspondence.
    // =========================================================================
    function nwAlign(src, tgt) {
        var sN = src.vertices.length, tN = tgt.vertices.length;
        if (sN === tN) return { src: clonePath(src), tgt: alignPaths(src, tgt) };

        // Always expand the SHORTER path to match the LONGER
        var flipped = sN > tN;
        var shorter = flipped ? tgt : src;
        var longer  = flipped ? src : tgt;
        var n = shorter.vertices.length, m = longer.vertices.length;

        // ── 1. Best cyclic rotation of the longer path ────────────────────────
        var step = Math.max(1, Math.floor(m / 60));
        var bestRot = 0, bestScore = Infinity;
        for (var rot = 0; rot < m; rot += step) {
            var sc = 0;
            for (var i = 0; i < n; i++) {
                var j = Math.round((i / n) * m + rot) % m;
                var dx = shorter.vertices[i][0] - longer.vertices[j][0];
                var dy = shorter.vertices[i][1] - longer.vertices[j][1];
                sc += dx*dx + dy*dy;
            }
            if (sc < bestScore) { bestScore = sc; bestRot = rot; }
        }
        // Fine-tune around best
        for (var k = bestRot - step; k <= bestRot + step; k++) {
            var rr = ((k % m) + m) % m;
            var sc = 0;
            for (var i = 0; i < n; i++) {
                var j = Math.round((i / n) * m + rr) % m;
                var dx = shorter.vertices[i][0] - longer.vertices[j][0];
                var dy = shorter.vertices[i][1] - longer.vertices[j][1];
                sc += dx*dx + dy*dy;
            }
            if (sc < bestScore) { bestScore = sc; bestRot = rr; }
        }
        var longerR = rotatePath(longer, bestRot);

        // ── 2. NW DP table ────────────────────────────────────────────────────
        // Score: -distance between vertices (maximise = minimise travel).
        // Gap penalty: cost of inserting a dummy vertex in the shorter path.
        // Skipping a vertex in the longer path is heavily penalised to discourage it.
        var GAP = -40;
        var SKIP = GAP * 4;

        // Rolling two-row DP (saves memory vs full n×m table).
        // We still need the full direction table for backtracking.
        var prevRow = new Array(m + 1);
        for (var j = 0; j <= m; j++) prevRow[j] = j * GAP;

        // dir[i][j]: 0=match, 1=gap-in-shorter (insert dummy), 2=skip-longer-vertex
        var dir = [];
        dir[0] = new Array(m + 1);
        for (var j = 0; j <= m; j++) dir[0][j] = (j === 0) ? -1 : 1;

        for (var i = 1; i <= n; i++) {
            var currRow = new Array(m + 1);
            currRow[0] = i * SKIP;
            dir[i] = new Array(m + 1);
            dir[i][0] = 2;

            for (var j = 1; j <= m; j++) {
                var dx = shorter.vertices[i-1][0] - longerR.vertices[j-1][0];
                var dy = shorter.vertices[i-1][1] - longerR.vertices[j-1][1];
                var matchVal = prevRow[j-1] - Math.sqrt(dx*dx + dy*dy);
                var gapVal   = prevRow[j]   + GAP;   // dummy in shorter
                var skipVal  = currRow[j-1] + SKIP;  // skip a longer vertex

                if (matchVal >= gapVal && matchVal >= skipVal) {
                    currRow[j] = matchVal; dir[i][j] = 0;
                } else if (gapVal >= skipVal) {
                    currRow[j] = gapVal;  dir[i][j] = 1;
                } else {
                    currRow[j] = skipVal; dir[i][j] = 2;
                }
            }
            prevRow = currRow;
        }

        // ── 3. Backtrack ──────────────────────────────────────────────────────
        // alignment[k] = [shorterIdx | -1,  longerIdx | -1]
        var alignment = [];
        var ii = n, jj = m;
        while (ii > 0 || jj > 0) {
            if (ii === 0) { alignment.unshift([-1, --jj]); }
            else if (jj === 0) { alignment.unshift([--ii, -1]); }
            else {
                var d = dir[ii][jj];
                if (d === 0) { alignment.unshift([--ii, --jj]); }
                else if (d === 1) { alignment.unshift([-1, --jj]); }
                else { alignment.unshift([--ii, -1]); }
            }
        }

        // ── 4. Build expanded shorter path with on-curve dummy points ─────────
        // Dummies are NOT at midpoints — they're placed ON the original Bézier
        // curve at the parametric t that corresponds to their position in the gap.
        var nV = [], nI = [], nO = [];

        for (var k = 0; k < alignment.length; k++) {
            var si = alignment[k][0];
            if (si >= 0) {
                // Real vertex — copy as-is
                nV.push([shorter.vertices[si][0], shorter.vertices[si][1]]);
                nI.push([shorter.inTangents[si][0],  shorter.inTangents[si][1]]);
                nO.push([shorter.outTangents[si][0], shorter.outTangents[si][1]]);
            } else {
                // Gap: insert a dummy interpolated on the Bézier segment
                var prevSi = -1, nextSi = -1;
                for (var kk = k-1; kk >= 0; kk--) { if (alignment[kk][0] >= 0) { prevSi = alignment[kk][0]; break; } }
                for (var kk = k+1; kk < alignment.length; kk++) { if (alignment[kk][0] >= 0) { nextSi = alignment[kk][0]; break; } }
                if (prevSi < 0) prevSi = n - 1;
                if (nextSi < 0) nextSi = 0;

                // Find the span of this contiguous gap group to spread t evenly
                var gapS = k, gapE = k;
                while (gapS > 0 && alignment[gapS-1][0] < 0) gapS--;
                while (gapE < alignment.length-1 && alignment[gapE+1][0] < 0) gapE++;
                var t = (k - gapS + 1) / (gapE - gapS + 2);

                var p0 = shorter.vertices[prevSi];
                var nsi = nextSi % n;
                var p3 = shorter.vertices[nsi];
                var p1 = [p0[0] + shorter.outTangents[prevSi][0], p0[1] + shorter.outTangents[prevSi][1]];
                var p2 = [p3[0] + shorter.inTangents[nsi][0],     p3[1] + shorter.inTangents[nsi][1]];

                var pt  = bezierPt(p0, p1, p2, p3, t);
                var dt  = bezierTangent(p0, p1, p2, p3, t);
                var dl  = Math.sqrt(dt[0]*dt[0] + dt[1]*dt[1]);
                var sL  = segLen(p0, p1, p2, p3);
                var hL  = sL / Math.max(6, gapE - gapS + 3);
                var ux  = dl > 0 ? dt[0]/dl : 0, uy = dl > 0 ? dt[1]/dl : 0;

                nV.push(pt);
                nI.push([-ux*hL, -uy*hL]);
                nO.push([ ux*hL,  uy*hL]);
            }
        }

        var expandedShorter = { vertices: nV, inTangents: nI, outTangents: nO, closed: shorter.closed };

        // Return with original src/tgt orientation
        return flipped
            ? { src: clonePath(longerR), tgt: expandedShorter }
            : { src: expandedShorter,    tgt: clonePath(longerR) };
    }

    // =========================================================================
    //  AE LAYER / PATH UTILITIES
    // =========================================================================
    function getSelectedShapeLayer() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return null;
        var sel = comp.selectedLayers;
        if (!sel || !sel.length) return null;
        return (sel[0] instanceof ShapeLayer) ? sel[0] : null;
    }

    // =========================================================================
    //  PARAMETRIC SHAPE → BEZIER  (pure-script, no executeCommand needed)
    //
    //  After Effects stores Rectangle / Ellipse / Star as parametric props
    //  (ADBE Vector Shape - Rect/Ellipse/Star).  getAllPaths previously missed
    //  these entirely, forcing the user to manually "Convert to Bezier Path".
    //  These functions compute equivalent Bezier data directly from the
    //  parametric properties — works in both standalone and docked-panel mode.
    //
    //  Ellipse approximation uses the standard cubic Bézier magic constant:
    //    k = 4*(√2-1)/3 ≈ 0.5522847498
    //  This gives < 0.03 % error vs a true arc.
    // =========================================================================
    var KAPPA = 0.5522847498;

    function rectToBezierData(prop, time) {
        try {
            var sz  = prop.property("ADBE Vector Rect Size").valueAtTime(time, false);
            var pos = prop.property("ADBE Vector Rect Position").valueAtTime(time, false);
            var r   = 0;
            try { r = prop.property("ADBE Vector Rect Roundness").valueAtTime(time, false); } catch(e) {}
            var w = sz[0] / 2, h = sz[1] / 2, x = pos[0], y = pos[1];
            r = Math.min(r, Math.min(w, h));
            if (r <= 0) {
                return {
                    vertices:    [[x-w,y-h],[x+w,y-h],[x+w,y+h],[x-w,y+h]],
                    inTangents:  [[0,0],[0,0],[0,0],[0,0]],
                    outTangents: [[0,0],[0,0],[0,0],[0,0]],
                    closed: true
                };
            }
            // Rounded corners — 2 vertices per corner, 8 total
            var kr = KAPPA * r;
            return {
                vertices:    [[x+w-r,y-h],[x+w,y-h+r],[x+w,y+h-r],[x+w-r,y+h],
                               [x-w+r,y+h],[x-w,y+h-r],[x-w,y-h+r],[x-w+r,y-h]],
                inTangents:  [[0,0],[0,-kr],[0,0],[kr,0],[0,0],[0,kr],[0,0],[-kr,0]],
                outTangents: [[kr,0],[0,0],[ 0,kr],[0,0],[-kr,0],[0,0],[0,-kr],[0,0]],
                closed: true
            };
        } catch(e) { return null; }
    }

    function ellipseToBezierData(prop, time) {
        try {
            var sz  = prop.property("ADBE Vector Ellipse Size").valueAtTime(time, false);
            var pos = prop.property("ADBE Vector Ellipse Position").valueAtTime(time, false);
            var rx = sz[0]/2, ry = sz[1]/2, x = pos[0], y = pos[1];
            var kx = KAPPA*rx, ky = KAPPA*ry;
            return {
                vertices:    [[x,y-ry],[x+rx,y],[x,y+ry],[x-rx,y]],
                inTangents:  [[-kx,0],[0,-ky],[kx,0],[0,ky]],
                outTangents: [[kx,0],[0,ky],[-kx,0],[0,-ky]],
                closed: true
            };
        } catch(e) { return null; }
    }

    function starToBezierData(prop, time) {
        try {
            var type  = Math.round(prop.property("ADBE Vector Star Type").valueAtTime(time, false));
            var nPts  = Math.round(prop.property("ADBE Vector Star Points").valueAtTime(time, false));
            var pos   = prop.property("ADBE Vector Star Position").valueAtTime(time, false);
            var rotD  = prop.property("ADBE Vector Star Rotation").valueAtTime(time, false);
            var outR  = prop.property("ADBE Vector Star Outer Radius").valueAtTime(time, false);
            var inR   = outR;
            var outRnd = 0, inRnd = 0;
            try { inR    = prop.property("ADBE Vector Star Inner Radius").valueAtTime(time, false); } catch(e) {}
            try { outRnd = prop.property("ADBE Vector Star Outer Roundness").valueAtTime(time, false) / 100; } catch(e) {}
            try { inRnd  = prop.property("ADBE Vector Star Inner Roundness").valueAtTime(time, false) / 100; } catch(e) {}

            var isPoly = (type === 2);
            var total  = isPoly ? nPts : nPts * 2;
            var rot    = rotD * Math.PI / 180 - Math.PI / 2;
            var v = [], iT = [], oT = [];

            for (var k = 0; k < total; k++) {
                var ang  = rot + (k / total) * 2 * Math.PI;
                var rad  = isPoly ? outR : (k % 2 === 0 ? outR : inR);
                var rnd  = isPoly ? outRnd : (k % 2 === 0 ? outRnd : inRnd);
                v.push([pos[0] + rad * Math.cos(ang), pos[1] + rad * Math.sin(ang)]);
                if (rnd === 0) {
                    iT.push([0,0]); oT.push([0,0]);
                } else {
                    var segAng = (2 * Math.PI / total);
                    var tLen   = rad * Math.tan(segAng / 2) * rnd;
                    var tx = -Math.sin(ang) * tLen, ty = Math.cos(ang) * tLen;
                    iT.push([-tx,-ty]); oT.push([tx,ty]);
                }
            }
            return { vertices: v, inTangents: iT, outTangents: oT, closed: true };
        } catch(e) { return null; }
    }

    // Returns true if the prop is one of the three parametric shape types
    function isParametricProp(prop) {
        var mn = "";
        try { mn = prop.matchName; } catch(e) {}
        return mn === "ADBE Vector Shape - Rect" ||
               mn === "ADBE Vector Shape - Ellipse" ||
               mn === "ADBE Vector Shape - Star";
    }

    // Compute Bezier path data from a parametric prop at a given time
    function parametricToBezierData(prop, time) {
        var mn = "";
        try { mn = prop.matchName; } catch(e) {}
        if (mn === "ADBE Vector Shape - Rect")    return rectToBezierData(prop, time);
        if (mn === "ADBE Vector Shape - Ellipse") return ellipseToBezierData(prop, time);
        if (mn === "ADBE Vector Shape - Star")    return starToBezierData(prop, time);
        return null;
    }

    // getAllPaths now collects BOTH Bezier paths AND parametric shapes.
    // Parametric props are tagged so compPaths knows to compute them instead
    // of calling valueAtTime (which would fail / give wrong type).
    function getAllPaths(layer) {
        var paths = [];
        function recurse(prop) {
            var mn = "";
            try { mn = prop.matchName; } catch(e) { return; }
            if (mn === "ADBE Vector Shape" && prop.value) {
                paths.push(prop);
            } else if (mn === "ADBE Vector Shape - Rect" ||
                       mn === "ADBE Vector Shape - Ellipse" ||
                       mn === "ADBE Vector Shape - Star") {
                paths.push(prop); // parametric — handled in compPaths
            }
            var n = 0; try { n = prop.numProperties; } catch(e) {}
            for (var i = 1; i <= n; i++) {
                try { recurse(prop.property(i)); } catch (e) { }
            }
        }
        recurse(layer.property("ADBE Root Vectors Group"));
        return paths;
    }

    // Scan the layer's property tree for a Merge Paths operator.
    // Returns the merge-type integer (1–5) if found, or null if the layer has no boolean ops.
    // We copy the value straight from source so we never need to know what each integer means.
    function detectLayerMergeMode(layer) {
        function scan(prop) {
            var mn = "";
            try { mn = prop.matchName; } catch(e) { return null; }
            if (mn === "ADBE Vector Filter - Merge") {
                try { return prop.property("ADBE Vector Merge Type").value; } catch(e) { return 1; }
            }
            var n = 0;
            try { n = prop.numProperties; } catch(e) { return null; }
            for (var i = 1; i <= n; i++) {
                try { var r = scan(prop.property(i)); if (r !== null) return r; } catch(e) {}
            }
            return null;
        }
        try { return scan(layer.property("ADBE Root Vectors Group")); } catch(e) {}
        return null;
    }

    // Returns a style object with fill + stroke data from the path's parent group.
    // Handles solid fills, gradient fills (approximated), stroke-only shapes, and both.
    // Hierarchy note:
    //   Bezier  path: prop → ADBE Vector Shape - Group → ADBE Vectors Group (has fill/stroke)
    //   Parametric:   prop →                             ADBE Vectors Group (has fill/stroke)
    // So parametric props need ONE fewer .parentProperty step.
    function getPathStyle(pathProp) {
        var s = {
            hasFill: false,
            fillColor: [1, 1, 1, 1],
            hasStroke: false,
            strokeColor: [1, 1, 1, 1],
            strokeWidth: 2
        };
        try {
            var grp = isParametricProp(pathProp)
                ? pathProp.parentProperty          // parametric: 1 level up = ADBE Vectors Group
                : pathProp.parentProperty.parentProperty; // bezier: 2 levels up = ADBE Vectors Group

            // ── Fill ───────────────────────────────────────────────────────────
            var fill = null;
            try { fill = grp.property("ADBE Vector Graphic - Fill"); } catch (e) { }
            if (fill) {
                s.hasFill = true;
                // Try solid color first; gradient fills throw here
                try {
                    s.fillColor = fill.property("ADBE Vector Fill Color").value;
                } catch (e) {
                    // Gradient fill — approximate with first stop color
                    try {
                        var stops = fill.property("ADBE Vector Grad Colors").value;
                        // Gradient color stops: [pos, r, g, b, ...] interleaved
                        if (stops && stops.length >= 4) {
                            s.fillColor = [stops[1], stops[2], stops[3], 1];
                        }
                    } catch (e2) {
                        s.fillColor = [0.5, 0.5, 0.5, 1]; // safe gray fallback
                    }
                }
            }

            // ── Stroke ─────────────────────────────────────────────────────────
            var stroke = null;
            try { stroke = grp.property("ADBE Vector Graphic - Stroke"); } catch (e) { }
            if (stroke) {
                s.hasStroke = true;
                try { s.strokeColor = stroke.property("ADBE Vector Stroke Color").value; } catch (e) { }
                try { s.strokeWidth = stroke.property("ADBE Vector Stroke Width").value; } catch (e) { }
            }
        } catch (e) { }
        return s;
    }

    // Get all path data in comp space (Optimized: Pre-fetches matrices to eliminate valueAtTime bottleneck)
    function compPaths(layer, pathProps, time) {
        // 1. Pre-fetch layer transforms
        var layerXF = [];
        var lyr = layer;
        while (lyr) {
            var tr = lyr.property("ADBE Transform Group");
            if (tr) {
                var pos = [0,0], anc = [0,0], scl = [100,100], rot = 0;
                try { pos = tr.property("ADBE Position").valueAtTime(time, false); } catch(e){}
                try { anc = tr.property("ADBE Anchor Point").valueAtTime(time, false); } catch(e){}
                try { scl = tr.property("ADBE Scale").valueAtTime(time, false); } catch(e){}
                try { rot = tr.property("ADBE Rotation").valueAtTime(time, false); } catch(e){}
                layerXF.push({ pos: pos, anc: anc, scl: scl, rot: rot });
            }
            lyr = lyr.parent;
        }

        var results = [];
        for (var i = 0; i < pathProps.length; i++) {
            var pp = pathProps[i];
            // Parametric shapes (Rect/Ellipse/Star) cannot be read via valueAtTime —
            // compute their Bezier equivalent directly from the parametric properties.
            var shape = isParametricProp(pp)
                ? parametricToBezierData(pp, time)
                : pp.valueAtTime(time, false);
            if (!shape || !shape.vertices || shape.vertices.length < 2) continue;
            
            // 2. Pre-fetch group transforms
            var grpXF = [];
            var curr = pp.parentProperty;
            while (curr && curr.parentProperty) {
                if (curr.matchName === "ADBE Vector Group") {
                    try {
                        var mg = curr.property("ADBE Vector Transform Group");
                        var gpos = [0,0], ganc = [0,0], gscl = [100,100], grot = 0;
                        if (mg.property("ADBE Vector Position")) gpos = mg.property("ADBE Vector Position").valueAtTime(time, false);
                        if (mg.property("ADBE Vector Anchor Point")) ganc = mg.property("ADBE Vector Anchor Point").valueAtTime(time, false);
                        if (mg.property("ADBE Vector Scale")) gscl = mg.property("ADBE Vector Scale").valueAtTime(time, false);
                        if (mg.property("ADBE Vector Rotation")) grot = mg.property("ADBE Vector Rotation").valueAtTime(time, false);
                        grpXF.push({ pos: gpos, anc: ganc, scl: gscl, rot: grot });
                    } catch(e){}
                }
                curr = curr.parentProperty;
            }

            var cV = [], cI = [], cO = [];
            for (var k = 0; k < shape.vertices.length; k++) {
                var v = [shape.vertices[k][0], shape.vertices[k][1]];
                var it = [shape.inTangents[k][0], shape.inTangents[k][1]];
                var ot = [shape.outTangents[k][0], shape.outTangents[k][1]];
                
                // 3. Apply group transforms
                for (var m = 0; m < grpXF.length; m++) {
                    var xf = grpXF[m];
                    var x = v[0] - xf.anc[0], y = v[1] - xf.anc[1];
                    x *= xf.scl[0]/100; y *= xf.scl[1]/100;
                    var r = xf.rot * Math.PI / 180;
                    v = [xf.pos[0] + x*Math.cos(r) - y*Math.sin(r), xf.pos[1] + x*Math.sin(r) + y*Math.cos(r)];
                    
                    var ix = it[0] * (xf.scl[0]/100), iy = it[1] * (xf.scl[1]/100);
                    it = [ix*Math.cos(r) - iy*Math.sin(r), ix*Math.sin(r) + iy*Math.cos(r)];
                    
                    var ox = ot[0] * (xf.scl[0]/100), oy = ot[1] * (xf.scl[1]/100);
                    ot = [ox*Math.cos(r) - oy*Math.sin(r), ox*Math.sin(r) + oy*Math.cos(r)];
                }

                // 4. Apply layer transforms
                for (var l = 0; l < layerXF.length; l++) {
                    var xf = layerXF[l];
                    var x = v[0] - xf.anc[0], y = v[1] - xf.anc[1];
                    x *= xf.scl[0]/100; y *= xf.scl[1]/100;
                    var r = xf.rot * Math.PI / 180;
                    v = [xf.pos[0] + x*Math.cos(r) - y*Math.sin(r), xf.pos[1] + x*Math.sin(r) + y*Math.cos(r)];
                    
                    var ix = it[0] * (xf.scl[0]/100), iy = it[1] * (xf.scl[1]/100);
                    it = [ix*Math.cos(r) - iy*Math.sin(r), ix*Math.sin(r) + iy*Math.cos(r)];
                    
                    var ox = ot[0] * (xf.scl[0]/100), oy = ot[1] * (xf.scl[1]/100);
                    ot = [ox*Math.cos(r) - oy*Math.sin(r), ox*Math.sin(r) + oy*Math.cos(r)];
                }

                cV.push(v);
                cI.push(it);
                cO.push(ot);
            }
            results.push({ vertices: cV, inTangents: cI, outTangents: cO, closed: shape.closed });
        }
        return results;
    }

    function boundsCenter(pathsArr) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var p = 0; p < pathsArr.length; p++) {
            for (var i = 0; i < pathsArr[p].vertices.length; i++) {
                var v = pathsArr[p].vertices[i];
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
            }
        }
        return (minX === Infinity) ? [0, 0] : [(minX + maxX) / 2, (minY + maxY) / 2];
    }

    function centerPath(path, cx, cy) {
        var c = clonePath(path);
        for (var v = 0; v < c.vertices.length; v++) {
            c.vertices[v] = [c.vertices[v][0] - cx, c.vertices[v][1] - cy];
        }
        return c;
    }

    // Auto-convert parametric shapes (Rect/Ellipse/Star) to Bezier
    function convertToBezier(layer) {
        var comp = app.project.activeItem;
        if (!comp) return;
        var hasP = false;
        function scanP(prop) {
            if (prop.matchName === "ADBE Vector Shape - Rect" ||
                prop.matchName === "ADBE Vector Shape - Ellipse" ||
                prop.matchName === "ADBE Vector Shape - Star") {
                prop.selected = true; hasP = true;
            }
            for (var i = 1; i <= prop.numProperties; i++) { try { scanP(prop.property(i)); } catch (e) { } }
        }
        var oldSel = comp.selectedProperties;
        for (var i = 0; i < oldSel.length; i++) oldSel[i].selected = false;
        scanP(layer.property("ADBE Root Vectors Group"));
        if (hasP) {
            var cmd = app.findCommandID("Convert to Bezier Path") || 3736;
            // Force comp viewer focus so executeCommand operates on the right context
            try { if (app.activeViewer) app.activeViewer.setActive(); } catch (e) { }
            try { app.executeCommand(cmd); } catch (e) { }
        }
        var curSel = comp.selectedProperties;
        for (var i = 0; i < curSel.length; i++) curSel[i].selected = false;
        layer.selected = true;
    }

    // Safely hide a layer — unlocks it first if needed
    function safeHide(layer) {
        try { if (layer.locked) layer.locked = false; } catch (e) { }
        try { layer.enabled = false; } catch (e) { }
    }

    // Returns true if any vector group in the layer has a non-zero skew transform
    function hasSkew(layer) {
        function checkProp(prop) {
            if (prop.matchName === "ADBE Vector Skew") {
                try { if (Math.abs(prop.value) > 0.01) return true; } catch (e) { }
            }
            for (var i = 1; i <= prop.numProperties; i++) {
                try { if (checkProp(prop.property(i))) return true; } catch (e) { }
            }
            return false;
        }
        try { return checkProp(layer.property("ADBE Root Vectors Group")); } catch (e) { }
        return false;
    }

    // =========================================================================
    //  EASING
    // =========================================================================
    function applyEase(prop, time, influence) {
        try {
            if (prop.numKeys > 0) {
                var kIdx = prop.nearestKeyIndex(time);
                if (Math.abs(prop.keyTime(kIdx) - time) < 0.001) {
                    if (influence > 0) {
                        var ea = new KeyframeEase(0, influence);
                        var easeArr = [ea];
                        
                        // 2D/3D properties need an array of KeyframeEase objects matching dimensions
                        if (prop.propertyValueType === PropertyValueType.TwoD) easeArr = [ea, ea];
                        if (prop.propertyValueType === PropertyValueType.ThreeD) easeArr = [ea, ea, ea];
                        
                        try {
                            prop.setTemporalEaseAtKey(kIdx, easeArr, easeArr);
                        } catch(e2) {
                            try { prop.setTemporalEaseAtKey(kIdx, [ea, ea, ea], [ea, ea, ea]); } 
                            catch(e3) { try { prop.setTemporalEaseAtKey(kIdx, [ea], [ea]); } catch(e4) {} }
                        }
                    } else {
                        prop.setInterpolationTypeAtKey(kIdx, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                    }
                }
            }
        } catch (e) { }
    }

    // =========================================================================
    //  UNIQUE LAYER NAME
    // =========================================================================
    function nextName(tag) {
        SESSION.renderCount++;
        var n = SESSION.renderCount;
        return "OM_" + (tag || "Morph") + "_" + (n < 10 ? "0" + n : "" + n);
    }

    // =========================================================================
    //  CORE ENGINE — write one morph segment to a render layer's root
    //
    //  srcPaths / tgtPaths : arrays of path data (comp space)
    //  srcStyles / tgtStyles: style objects from getPathStyle() — fill + stroke
    //  t0, t1             : start / end times
    //  sCenter, tCenter   : bounding box centers (localization)
    //
    //  Handles  1:1 / SPLIT (src<tgt) / MERGE (src>tgt)
    //  Handles  fill-only / stroke-only / fill+stroke / gradient fill (approx)
    // =========================================================================
    // ── Boolean (hole-aware) segment  —  ShapeShifter technique ───────────────
    //
    // Approach (from Alex Lockwood / ShapeShifter):
    //   • NO Merge Paths operator needed.
    //   • All sub-paths go into ONE group with Even-Odd fill rule.
    //     The outer path fills normally; wherever the inner (hole) path overlaps,
    //     the Even-Odd rule toggles the fill off → transparent hole, no operator required.
    //   • When src has a hole and tgt does NOT (or vice-versa), the missing side
    //     gets a "collapsed dummy sub-path" — all vertices stacked at the shape's
    //     center (invisible to the viewer). During the morph the hole appears to be
    //     "sucked into a black hole" or to emerge from a single point. Classic effect.
    // =========================================================================

    // All-zero path: every vertex at [0,0] (centered-space center). Safe to pass
    // through normalizePath because n === maxPts → early-return guard triggers.
    function collapsedDummy(vertCount, closed) {
        var v = [], i = [], o = [];
        for (var k = 0; k < vertCount; k++) {
            v.push([0, 0]); i.push([0, 0]); o.push([0, 0]);
        }
        return { vertices: v, inTangents: i, outTangents: o, closed: closed !== false };
    }

    function writeBooleanSegment(renderRoot, srcPaths, tgtPaths, srcStyles, tgtStyles, t0, t1, sCenter, tCenter) {
        var outCount = Math.max(srcPaths.length, tgtPaths.length);
        var maxPts = CFG.minVertices;
        for (var p = 0; p < outCount; p++) {
            if (p < srcPaths.length && srcPaths[p]) maxPts = Math.max(maxPts, srcPaths[p].vertices.length);
            if (p < tgtPaths.length && tgtPaths[p]) maxPts = Math.max(maxPts, tgtPaths[p].vertices.length);
        }
        var defaultStyle = { hasFill: true, fillColor: [1,1,1,1], hasStroke: false, strokeColor: [1,1,1,1], strokeWidth: 2 };

        // ── Build container group once; chain calls reuse it ──────────────────
        var boolGrp = renderRoot.property("BoolGroup");
        if (!boolGrp) {
            boolGrp = renderRoot.addProperty("ADBE Vector Group");
            boolGrp.name = "BoolGroup";
            var bgc = boolGrp.property("ADBE Vectors Group");
            // One sub-group per output path (paths first, fill last — AE render order)
            for (var p = 0; p < outCount; p++) {
                var pg = bgc.addProperty("ADBE Vector Group");
                pg.name = "Path " + (p + 1);
                pg.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");
            }
            // Shared fill — Even-Odd rule makes overlapping sub-paths transparent (the hole)
            var sStyle0 = srcStyles[0] || defaultStyle;
            if (sStyle0.hasFill || !sStyle0.hasStroke) {
                var fillProp = bgc.addProperty("ADBE Vector Graphic - Fill");
                // Even-Odd fill rule: value 2.  Non-Zero Winding = 1 (AE default).
                try { fillProp.property("ADBE Vector Fill Rule").setValue(2); } catch(e) {}
            }
            if (sStyle0.hasStroke) bgc.addProperty("ADBE Vector Graphic - Stroke");
        }

        var bgc = boolGrp.property("ADBE Vectors Group");

        // ── Keyframe each path ────────────────────────────────────────────────
        for (var p = 0; p < outCount; p++) {
            var srcN, tgtFinal;

            if (p < srcPaths.length && p < tgtPaths.length) {
                // ── Both sides exist: NW alignment ────────────────────────────
                var locSrc = centerPath(srcPaths[p], sCenter[0], sCenter[1]);
                var locTgt = centerPath(tgtPaths[p], tCenter[0], tCenter[1]);
                if (CFG.autoAlign) {
                    var tmpS = normalizePath(locSrc, 4), tmpT = normalizePath(locTgt, 4);
                    if (signedArea(tmpS) * signedArea(tmpT) < 0) locTgt = reversePath(locTgt);
                    var preS = locSrc.vertices.length >= CFG.minVertices ? locSrc : normalizePath(locSrc, CFG.minVertices);
                    var preT = locTgt.vertices.length >= CFG.minVertices ? locTgt : normalizePath(locTgt, CFG.minVertices);
                    var nw = nwAlign(preS, preT);
                    srcN = nw.src; tgtFinal = nw.tgt;
                } else {
                    srcN = normalizePath(locSrc, maxPts);
                    var tgtN = normalizePath(locTgt, maxPts);
                    if (signedArea(srcN) * signedArea(tgtN) < 0) tgtN = reversePath(tgtN);
                    tgtFinal = rotatePath(tgtN, CFG.vertexOffset);
                }

            } else if (p >= srcPaths.length) {
                // ── Extra target path: src = collapsed dummy at sCenter ────────
                // The hole "grows out of nothing" — ShapeShifter collapsed-dummy trick.
                var locTgt = centerPath(tgtPaths[p], tCenter[0], tCenter[1]);
                tgtFinal = normalizePath(locTgt, maxPts);
                // collapsedDummy already has maxPts vertices → normalizePath no-ops
                srcN = collapsedDummy(maxPts, tgtPaths[p].closed);

            } else {
                // ── Extra source path: tgt = collapsed dummy at tCenter ────────
                // The hole "gets sucked into a black hole" — Lockwood's description.
                var locSrc = centerPath(srcPaths[p], sCenter[0], sCenter[1]);
                srcN = normalizePath(locSrc, maxPts);
                tgtFinal = collapsedDummy(maxPts, srcPaths[p].closed);
            }

            var pg = bgc.property(p + 1); // path sub-groups are 1-indexed
            var rPath = pg.property("ADBE Vectors Group").property(1).property("ADBE Vector Shape");
            rPath.setValueAtTime(t0, aeShape(srcN));
            rPath.setValueAtTime(t1, aeShape(tgtFinal));
            applyEase(rPath, t0, CFG.easing); applyEase(rPath, t1, CFG.easing);
        }

        // ── Keyframe shared fill / stroke ─────────────────────────────────────
        for (var pi = 1; pi <= bgc.numProperties; pi++) {
            var prop = bgc.property(pi);
            if (!prop) continue;
            var mn = ""; try { mn = prop.matchName; } catch(e) { continue; }
            if (mn === "ADBE Vector Graphic - Fill") {
                try {
                    var sStyle0 = srcStyles[0] || defaultStyle, tStyle0 = tgtStyles[0] || defaultStyle;
                    var fc = prop.property("ADBE Vector Fill Color");
                    fc.setValueAtTime(t0, sStyle0.fillColor || [1,1,1,1]);
                    fc.setValueAtTime(t1, tStyle0.fillColor || [1,1,1,1]);
                    applyEase(fc, t0, CFG.easing); applyEase(fc, t1, CFG.easing);
                } catch(e) {}
            } else if (mn === "ADBE Vector Graphic - Stroke") {
                try {
                    var sStyle0 = srcStyles[0] || defaultStyle, tStyle0 = tgtStyles[0] || defaultStyle;
                    var sc = prop.property("ADBE Vector Stroke Color");
                    var sw = prop.property("ADBE Vector Stroke Width");
                    sc.setValueAtTime(t0, sStyle0.strokeColor || [0,0,0,1]);
                    sc.setValueAtTime(t1, tStyle0.strokeColor || [0,0,0,1]);
                    sw.setValueAtTime(t0, sStyle0.strokeWidth || 2);
                    sw.setValueAtTime(t1, tStyle0.strokeWidth || 2);
                    applyEase(sc, t0, CFG.easing); applyEase(sc, t1, CFG.easing);
                    applyEase(sw, t0, CFG.easing); applyEase(sw, t1, CFG.easing);
                } catch(e) {}
            }
        }
    }

    function writeSegment(renderRoot, srcPaths, tgtPaths, srcStyles, tgtStyles, t0, t1, sCenter, tCenter, mergeMode) {
        // Delegate to boolean-aware (Even-Odd + collapsed-dummy) writer when the
        // source layer has a Merge Paths / boolean operator — no mergeMode arg needed.
        if (mergeMode != null && Math.max(srcPaths.length, tgtPaths.length) > 1) {
            writeBooleanSegment(renderRoot, srcPaths, tgtPaths, srcStyles, tgtStyles, t0, t1, sCenter, tCenter);
            return;
        }

        var outCount = Math.max(srcPaths.length, tgtPaths.length);

        // Global vertex count for this segment
        var maxPts = CFG.minVertices;
        for (var p = 0; p < outCount; p++) {
            if (p < srcPaths.length && srcPaths[p]) maxPts = Math.max(maxPts, srcPaths[p].vertices.length);
            if (p < tgtPaths.length && tgtPaths[p]) maxPts = Math.max(maxPts, tgtPaths[p].vertices.length);
        }

        var defaultStyle = { hasFill: true, fillColor: [1, 1, 1, 1], hasStroke: false, strokeColor: [1, 1, 1, 1], strokeWidth: 2 };
        var usedNames = {};

        for (var p = 0; p < outCount; p++) {
            var gName = "Path " + (p + 1);
            var attempt = gName, sfx = 2;
            while (usedNames[attempt]) { attempt = gName + " " + sfx; sfx++; }
            gName = attempt; usedNames[gName] = true;

            var sPath, tPath, sStyle, tStyle;
            if (p < srcPaths.length && p < tgtPaths.length) {
                sPath = srcPaths[p]; tPath = tgtPaths[p];
                sStyle = srcStyles[p] || defaultStyle; tStyle = tgtStyles[p] || defaultStyle;
            } else if (p >= srcPaths.length) {
                // SPLIT: source duplicates toward each extra target
                sPath = srcPaths[0]; tPath = tgtPaths[p];
                sStyle = srcStyles[0] || defaultStyle; tStyle = tgtStyles[p] || tgtStyles[0] || defaultStyle;
            } else {
                // MERGE: extra sources converge to target[0]
                sPath = srcPaths[p]; tPath = tgtPaths[0];
                sStyle = srcStyles[p] || srcStyles[0] || defaultStyle; tStyle = tgtStyles[0] || defaultStyle;
            }

            // Localize → fix winding → align (NW or manual)
            var locSrc = centerPath(sPath, sCenter[0], sCenter[1]);
            var locTgt = centerPath(tPath, tCenter[0], tCenter[1]);
            var srcN, tgtFinal;
            if (CFG.autoAlign) {
                // Fix winding first so NW doesn't try to match a CW path to a CCW one
                var tmpS = normalizePath(locSrc, 4), tmpT = normalizePath(locTgt, 4);
                if (signedArea(tmpS) * signedArea(tmpT) < 0) locTgt = reversePath(locTgt);
                // Ensure minimum vertex density before NW (guarantees smooth arcs)
                var preS = locSrc.vertices.length >= CFG.minVertices ? locSrc : normalizePath(locSrc, CFG.minVertices);
                var preT = locTgt.vertices.length >= CFG.minVertices ? locTgt : normalizePath(locTgt, CFG.minVertices);
                // NW finds optimal correspondence + rotation, inserting dummies on-curve
                var nw = nwAlign(preS, preT);
                srcN = nw.src; tgtFinal = nw.tgt;
            } else {
                srcN = normalizePath(locSrc, maxPts);
                var tgtN = normalizePath(locTgt, maxPts);
                if (signedArea(srcN) * signedArea(tgtN) < 0) tgtN = reversePath(tgtN);
                tgtFinal = rotatePath(tgtN, CFG.vertexOffset);
            }

            // Find or create group (chain calls reuse existing groups)
            var grp = renderRoot.property(gName);
            if (!grp) {
                grp = renderRoot.addProperty("ADBE Vector Group");
                grp.name = gName;
                var gc = grp.property("ADBE Vectors Group");
                gc.addProperty("ADBE Vector Shape - Group");
                // Add fill if either side has one, or if neither side has a stroke (fallback)
                var needFill = sStyle.hasFill || tStyle.hasFill || (!sStyle.hasStroke && !tStyle.hasStroke);
                var needStroke = sStyle.hasStroke || tStyle.hasStroke;
                if (needFill) gc.addProperty("ADBE Vector Graphic - Fill");
                if (needStroke) gc.addProperty("ADBE Vector Graphic - Stroke");
            }

            // ── Shape keyframes ────────────────────────────────────────────────
            var gc = grp.property("ADBE Vectors Group");
            var rPath = gc.property(1).property("ADBE Vector Shape");
            rPath.setValueAtTime(t0, aeShape(srcN));
            rPath.setValueAtTime(t1, aeShape(tgtFinal));
            applyEase(rPath, t0, CFG.easing); applyEase(rPath, t1, CFG.easing);

            // ── Fill / Stroke keyframes (find by matchName — order-safe) ───────
            for (var pi = 2; pi <= gc.numProperties; pi++) {
                var prop = gc.property(pi);
                if (prop.matchName === "ADBE Vector Graphic - Fill") {
                    try {
                        var fc = prop.property("ADBE Vector Fill Color");
                        fc.setValueAtTime(t0, sStyle.fillColor || [1, 1, 1, 1]);
                        fc.setValueAtTime(t1, tStyle.fillColor || [1, 1, 1, 1]);
                        applyEase(fc, t0, CFG.easing); applyEase(fc, t1, CFG.easing);
                    } catch (e) { }
                } else if (prop.matchName === "ADBE Vector Graphic - Stroke") {
                    try {
                        var sc = prop.property("ADBE Vector Stroke Color");
                        var sw = prop.property("ADBE Vector Stroke Width");
                        sc.setValueAtTime(t0, sStyle.strokeColor || [1, 1, 1, 1]);
                        sc.setValueAtTime(t1, tStyle.strokeColor || [1, 1, 1, 1]);
                        sw.setValueAtTime(t0, sStyle.strokeWidth || 2);
                        sw.setValueAtTime(t1, tStyle.strokeWidth || 2);
                        applyEase(sc, t0, CFG.easing); applyEase(sc, t1, CFG.easing);
                        applyEase(sw, t0, CFG.easing); applyEase(sw, t1, CFG.easing);
                    } catch (e) { }
                }
            }
        }
    }

    // =========================================================================
    //  SINGLE MORPH — one source → one target, always creates a NEW render layer
    // =========================================================================
    function execSingle() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) { alert("No active composition."); return false; }
        if (!SINGLE.srcLayer || !SINGLE.tgtLayer) { alert("Set both Source and Target layers first."); return false; }

        SINGLE.srcPaths = getAllPaths(SINGLE.srcLayer);
        SINGLE.tgtPaths = getAllPaths(SINGLE.tgtLayer);
        if (!SINGLE.srcPaths.length || !SINGLE.tgtPaths.length) {
            alert("One or both layers have no valid Bezier paths.\nRight-click parametric shapes and choose Convert to Bezier Path.");
            return false;
        }

        // Pre-flight warnings (non-fatal — user can cancel)
        var warns = [];
        if (SINGLE.srcLayer.threeDLayer || SINGLE.tgtLayer.threeDLayer)
            warns.push("3D Layer detected. Z-position will be ignored; morph stays at Z=0.");
        if (hasSkew(SINGLE.srcLayer) || hasSkew(SINGLE.tgtLayer))
            warns.push("Skewed group transform detected. The morph will not include skew.");
        if (warns.length && !confirm("Warnings:\n\u2022 " + warns.join("\n\u2022") + "\n\nContinue anyway?"))
            return false;

        app.beginUndoGroup("OM: Single Morph");
        try {
            var t0 = comp.time, t1 = t0 + CFG.duration;

            var srcCP = compPaths(SINGLE.srcLayer, SINGLE.srcPaths, t0);
            var tgtCP = compPaths(SINGLE.tgtLayer, SINGLE.tgtPaths, t1);
            var sStyles = [], tStyles = [];
            for (var i = 0; i < SINGLE.srcPaths.length; i++) sStyles.push(getPathStyle(SINGLE.srcPaths[i]));
            for (var i = 0; i < SINGLE.tgtPaths.length; i++) tStyles.push(getPathStyle(SINGLE.tgtPaths[i]));

            var sC = boundsCenter(srcCP), tC = boundsCenter(tgtCP);
            var srcMergeMode = detectLayerMergeMode(SINGLE.srcLayer);

            // Always create a BRAND NEW render layer — never reuse
            var tag = SINGLE.srcLayer.name.substring(0, 6) + ">" + SINGLE.tgtLayer.name.substring(0, 6);
            var renderLayer = comp.layers.addShape();
            renderLayer.name = nextName(tag);
            renderLayer.label = LBL_RENDER;

            // Null for position travel
            var ctrl = comp.layers.addNull();
            ctrl.name = "CTRL: " + SINGLE.srcLayer.name + " \u2192 " + SINGLE.tgtLayer.name;
            ctrl.label = LBL_NULL;
            ctrl.moveBefore(renderLayer);
            renderLayer.parent = ctrl;

            var nullPos = ctrl.property("ADBE Transform Group").property("ADBE Position");
            if (CFG.matchPosition) {
                nullPos.setValueAtTime(t0, sC);
                nullPos.setValueAtTime(t1, tC);
                applyEase(nullPos, t0, CFG.easing);
                applyEase(nullPos, t1, CFG.easing);
            } else {
                nullPos.setValue(sC);
            }

            writeSegment(
                renderLayer.property("ADBE Root Vectors Group"),
                srcCP, tgtCP, sStyles, tStyles,
                t0, t1, sC, tC, srcMergeMode
            );

            safeHide(SINGLE.srcLayer);
            app.endUndoGroup();
            return renderLayer.name;
        } catch (err) {
            app.endUndoGroup();
            alert("Single Morph Error:\n" + err.toString() + (err.line ? "\nLine: " + err.line : ""));
            return false;
        }
    }

    // =========================================================================
    //  CHAIN MORPH — A→B→C→D on ONE render layer with sequential keyframes
    //               Each step can have its own duration
    // =========================================================================
    function execChain() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) { alert("No active composition."); return false; }
        if (CHAIN.steps.length < 2) { alert("Add at least 2 steps to the chain."); return false; }

        // Validate all steps have paths
        for (var s = 0; s < CHAIN.steps.length; s++) {
            CHAIN.steps[s].paths = getAllPaths(CHAIN.steps[s].layer);
            if (!CHAIN.steps[s].paths.length) {
                alert("Step " + (s + 1) + " (" + CHAIN.steps[s].layer.name + ") has no valid Bezier paths.");
                return false;
            }
        }

        app.beginUndoGroup("OM: Chain Morph");
        try {
            var first = CHAIN.steps[0].layer.name.substring(0, 5);
            var last = CHAIN.steps[CHAIN.steps.length - 1].layer.name.substring(0, 5);
            var renderLayer = comp.layers.addShape();
            renderLayer.name = nextName("Chain_" + first + ".." + last);
            renderLayer.label = LBL_CHAIN;

            // One Null that travels through all positions
            var ctrl = comp.layers.addNull();
            ctrl.name = "CTRL: Chain (" + CHAIN.steps.length + " steps)";
            ctrl.label = LBL_NULL;
            ctrl.moveBefore(renderLayer);
            renderLayer.parent = ctrl;

            var nullPos = ctrl.property("ADBE Transform Group").property("ADBE Position");
            var renderRoot = renderLayer.property("ADBE Root Vectors Group");
            var t = comp.time;

            for (var step = 0; step < CHAIN.steps.length - 1; step++) {
                var src = CHAIN.steps[step];
                var tgt = CHAIN.steps[step + 1];
                var segDur = src.duration || CFG.duration;
                var t0 = t, t1 = t + segDur;

                var srcCP = compPaths(src.layer, src.paths, t0);
                var tgtCP = compPaths(tgt.layer, tgt.paths, t1);
                var sStyles = [], tStyles = [];
                for (var i = 0; i < src.paths.length; i++) sStyles.push(getPathStyle(src.paths[i]));
                for (var i = 0; i < tgt.paths.length; i++) tStyles.push(getPathStyle(tgt.paths[i]));

                var sC = boundsCenter(srcCP), tC = boundsCenter(tgtCP);
                var srcMergeMode = detectLayerMergeMode(src.layer);

                if (CFG.matchPosition) {
                    nullPos.setValueAtTime(t0, sC);
                    nullPos.setValueAtTime(t1, tC);
                    applyEase(nullPos, t0, CFG.easing);
                    applyEase(nullPos, t1, CFG.easing);
                }

                // Writes keyframes into existing groups if they exist (chain continuity)
                writeSegment(renderRoot, srcCP, tgtCP, sStyles, tStyles, t0, t1, sC, tC, srcMergeMode);

                safeHide(src.layer);
                t = t1;
            }
            // Hide last step layer too
            safeHide(CHAIN.steps[CHAIN.steps.length - 1].layer);

            app.endUndoGroup();
            return renderLayer.name;
        } catch (err) {
            app.endUndoGroup();
            alert("Chain Morph Error:\n" + err.toString() + (err.line ? "\nLine: " + err.line : ""));
            return false;
        }
    }

    // =========================================================================
    //  MULTI MORPH — each pair creates its own render layer, own timing
    // =========================================================================
    function execMulti() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) { alert("No active composition."); return false; }
        if (!MULTI.pairs.length) { alert("Add at least one morph pair."); return false; }

        var errs = [];
        for (var i = 0; i < MULTI.pairs.length; i++) {
            var pair = MULTI.pairs[i];
            if (!pair.srcLayer) errs.push("Pair " + (i + 1) + ": Source not set.");
            if (!pair.tgtLayer) errs.push("Pair " + (i + 1) + ": Target not set.");
        }
        if (errs.length) { alert("Fix before generating:\n" + errs.join("\n")); return false; }

        app.beginUndoGroup("OM: Multi Morph");
        try {
            var createdNames = [];
            for (var i = 0; i < MULTI.pairs.length; i++) {
                var pair = MULTI.pairs[i];
                pair.srcPaths = getAllPaths(pair.srcLayer);
                pair.tgtPaths = getAllPaths(pair.tgtLayer);
                if (!pair.srcPaths.length || !pair.tgtPaths.length) {
                    alert("Pair " + (i + 1) + ": One layer has no valid Bezier paths. Skipping.");
                    continue;
                }

                var startT = comp.time + (pair.startSec || 0);
                var dur = pair.duration || CFG.duration;
                var t0 = startT, t1 = t0 + dur;

                var srcCP = compPaths(pair.srcLayer, pair.srcPaths, t0);
                var tgtCP = compPaths(pair.tgtLayer, pair.tgtPaths, t1);
                var sStyles = [], tStyles = [];
                for (var k = 0; k < pair.srcPaths.length; k++) sStyles.push(getPathStyle(pair.srcPaths[k]));
                for (var k = 0; k < pair.tgtPaths.length; k++) tStyles.push(getPathStyle(pair.tgtPaths[k]));

                var sC = boundsCenter(srcCP), tC = boundsCenter(tgtCP);
                var srcMergeMode = detectLayerMergeMode(pair.srcLayer);

                var tag = pair.srcLayer.name.substring(0, 5) + ">" + pair.tgtLayer.name.substring(0, 5);
                var renderLayer = comp.layers.addShape();
                renderLayer.name = nextName(tag);
                renderLayer.label = LBL_RENDER;

                var ctrl = comp.layers.addNull();
                ctrl.name = "CTRL_" + i + ": " + pair.srcLayer.name + " \u2192 " + pair.tgtLayer.name;
                ctrl.label = LBL_NULL;
                ctrl.moveBefore(renderLayer);
                renderLayer.parent = ctrl;

                var nullPos = ctrl.property("ADBE Transform Group").property("ADBE Position");
                if (CFG.matchPosition) {
                    nullPos.setValueAtTime(t0, sC);
                    nullPos.setValueAtTime(t1, tC);
                    applyEase(nullPos, t0, CFG.easing);
                    applyEase(nullPos, t1, CFG.easing);
                } else {
                    nullPos.setValue(sC);
                }

                writeSegment(
                    renderLayer.property("ADBE Root Vectors Group"),
                    srcCP, tgtCP, sStyles, tStyles,
                    t0, t1, sC, tC, srcMergeMode
                );

                safeHide(pair.srcLayer);
                createdNames.push(renderLayer.name);
            }
            app.endUndoGroup();
            return createdNames;
        } catch (err) {
            app.endUndoGroup();
            alert("Multi Morph Error:\n" + err.toString() + (err.line ? "\nLine: " + err.line : ""));
            return false;
        }
    }

    // =========================================================================
    //  POST-MORPH: Bake selected OM render layer (remove Null, embed position)
    // =========================================================================
    function bakeSelected() {
        var comp = app.project.activeItem;
        if (!comp || (!(comp instanceof CompItem))) return "No active composition.";
        var sel = comp.selectedLayers;
        if (!sel || !sel.length) return "Select an OM render layer first.";
        var rl = sel[0];
        if (rl.name.indexOf("OM_") !== 0) return "The selected layer is not an OpenMorph render layer (name must start with OM_).";
        if (!rl.parent) return "This render layer has no Null parent — already clean.";

        app.beginUndoGroup("OM: Bake Null");
        var nullLayer = rl.parent;
        var nPos = nullLayer.property("ADBE Transform Group").property("ADBE Position");
        var lPos = rl.property("ADBE Transform Group").property("ADBE Position");
        if (nPos.numKeys > 0) {
            for (var k = 1; k <= nPos.numKeys; k++) {
                lPos.setValueAtTime(nPos.keyTime(k), nPos.keyValue(k));
                try { lPos.setTemporalEaseAtKey(k, nPos.keyInTemporalEase(k), nPos.keyOutTemporalEase(k)); } catch (e) { }
            }
        } else {
            lPos.setValue(nPos.value);
        }
        rl.parent = null;
        try { nullLayer.remove(); } catch (e) { }
        app.endUndoGroup();
        return "ok";
    }

    // =========================================================================
    //  POST-MORPH: Reverse winding on the active target layer
    // =========================================================================
    function reverseTargetPaths(layer) {
        var paths = getAllPaths(layer);
        if (!paths.length) return "No Bezier paths found on this layer.";
        var comp = app.project.activeItem;
        app.beginUndoGroup("OM: Reverse Winding");
        for (var i = 0; i < paths.length; i++) {
            var s = paths[i].valueAtTime(comp.time, false);
            var pd = { vertices: [], inTangents: [], outTangents: [], closed: s.closed };
            for (var k = 0; k < s.vertices.length; k++) {
                pd.vertices.push([s.vertices[k][0], s.vertices[k][1]]);
                pd.inTangents.push([s.inTangents[k][0], s.inTangents[k][1]]);
                pd.outTangents.push([s.outTangents[k][0], s.outTangents[k][1]]);
            }
            paths[i].setValue(aeShape(reversePath(pd)));
        }
        app.endUndoGroup();
        return paths.length;
    }

    // POST-MORPH: Nudge start vertex +1
    function nudgeTargetPaths(layer) {
        var paths = getAllPaths(layer);
        if (!paths.length) return "No Bezier paths found on this layer.";
        var comp = app.project.activeItem;
        app.beginUndoGroup("OM: Nudge Start Point");
        for (var i = 0; i < paths.length; i++) {
            var s = paths[i].valueAtTime(comp.time, false);
            var pd = { vertices: [], inTangents: [], outTangents: [], closed: s.closed };
            for (var k = 0; k < s.vertices.length; k++) {
                pd.vertices.push([s.vertices[k][0], s.vertices[k][1]]);
                pd.inTangents.push([s.inTangents[k][0], s.inTangents[k][1]]);
                pd.outTangents.push([s.outTangents[k][0], s.outTangents[k][1]]);
            }
            paths[i].setValue(aeShape(rotatePath(pd, 1)));
        }
        app.endUndoGroup();
        return paths.length;
    }

    // =========================================================================
    //  BOOLEAN-AWARE KEYFRAME OPTIMIZER  (Lockwood / ShapeShifter technique)
    //
    //  Fixes the "shards" / "twisting" distortion that appears when an
    //  already-keyframed multi-sub-path shape (e.g. boat hull + sails) morphs.
    //
    //  Workflow:
    //    1.  User selects ONE Path property in the timeline that has ≥2 keyframes.
    //    2.  We walk up to its parent "Vectors Group" container.
    //    3.  Every sibling path inside that container is collected.
    //    4.  Each path's keyframes (or static value, for newly-added siblings)
    //        are forced to the same winding order, then NW-aligned so vertices
    //        travel the minimum distance between poses.
    //    5.  Static siblings get a collapsed-dummy keyframe at t0 → they "grow"
    //        out of the main shape's centre instead of popping in.
    //    6.  The container's Fill is switched to Even-Odd so inner sub-paths act
    //        as cutouts automatically (no Merge Paths operator required).
    //    7.  Keyframes are eased to 75 % for that polished look.
    // =========================================================================
    function readPathSnapshot(s) {
        var pd = { vertices: [], inTangents: [], outTangents: [], closed: s.closed };
        for (var k = 0; k < s.vertices.length; k++) {
            pd.vertices.push([s.vertices[k][0], s.vertices[k][1]]);
            pd.inTangents.push([s.inTangents[k][0], s.inTangents[k][1]]);
            pd.outTangents.push([s.outTangents[k][0], s.outTangents[k][1]]);
        }
        return pd;
    }

    function pathBBoxCenter(pd) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var k = 0; k < pd.vertices.length; k++) {
            var v = pd.vertices[k];
            if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
            if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
        }
        if (minX === Infinity) return { center: [0, 0], area: 0 };
        return { center: [(minX + maxX) / 2, (minY + maxY) / 2], area: (maxX - minX) * (maxY - minY) };
    }

    // collapsedDummy already exists for the writer; this variant lets us place
    // the dummy at an arbitrary anchor point in path-local space.
    function collapsedDummyAt(vertCount, closed, cx, cy) {
        var v = [], i = [], o = [];
        for (var k = 0; k < vertCount; k++) {
            v.push([cx, cy]); i.push([0, 0]); o.push([0, 0]);
        }
        return { vertices: v, inTangents: i, outTangents: o, closed: closed !== false };
    }

    // Walk up the property chain until we hit an "ADBE Vectors Group" — that's
    // the container that holds the Fill and all sibling Vector Shape - Groups.
    function findContainerVectorsGroup(pathProp) {
        var p = pathProp;
        // Climb a few levels — Vector Shape → Vector Shape - Group → Vectors Group
        for (var hop = 0; hop < 6 && p; hop++) {
            var mn = "";
            try { mn = p.matchName; } catch (e) { break; }
            if (mn === "ADBE Vectors Group") return p;
            try { p = p.parentProperty; } catch (e) { break; }
        }
        return null;
    }

    function collectShapePathsInGroup(vectorsGroup) {
        var paths = [];
        function recurse(prop) {
            var mn = "";
            try { mn = prop.matchName; } catch (e) { return; }
            if (mn === "ADBE Vector Shape") { paths.push(prop); return; }
            // Don't dive into another container's siblings — but DO traverse
            // Vector Shape - Group wrappers and nested Vector Group/Vectors Group.
            var n = 0; try { n = prop.numProperties; } catch (e) { return; }
            for (var i = 1; i <= n; i++) {
                try { recurse(prop.property(i)); } catch (e) { }
            }
        }
        recurse(vectorsGroup);
        return paths;
    }

    // Find every Fill property living directly in this Vectors Group (one level deep).
    function collectFillsInGroup(vectorsGroup) {
        var fills = [];
        var n = 0; try { n = vectorsGroup.numProperties; } catch (e) { return fills; }
        for (var i = 1; i <= n; i++) {
            try {
                var child = vectorsGroup.property(i);
                var mn = ""; try { mn = child.matchName; } catch (e) { continue; }
                if (mn === "ADBE Vector Graphic - Fill") fills.push(child);
            } catch (e) { }
        }
        return fills;
    }

    function optimizeBooleanKeys() {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "Open a composition first.";
        var sel = comp.selectedProperties;
        if (!sel || !sel.length) return "Select a Path property with 2 keyframes.";

        // Find a keyframed Bezier path in the user's selection
        var seedPath = null;
        for (var i = 0; i < sel.length; i++) {
            var sp = sel[i];
            try {
                if (sp.matchName === "ADBE Vector Shape" && sp.numKeys >= 2) {
                    seedPath = sp; break;
                }
            } catch (e) { }
        }
        if (!seedPath) return "Select a Bezier Path property that has 2+ keyframes.";

        var t0 = seedPath.keyTime(1);
        var t1 = seedPath.keyTime(2);
        if (t1 <= t0) return "Keyframes must be at different times.";

        var container = findContainerVectorsGroup(seedPath);
        if (!container) return "Could not locate the parent Vectors Group.";

        var siblings = collectShapePathsInGroup(container);
        if (!siblings.length) return "No sibling paths found in the container.";

        app.beginUndoGroup("OM: Optimize Boolean Keys");

        // ── Snapshot every sibling at t0 and t1 ───────────────────────────────
        // animated=true  → uses its own keyframes 1 & 2 (re-mapped to seed t0/t1)
        // animated=false → static value re-used at both ends; later replaced by
        //                  a collapsed dummy at t0 so it grows from the centre.
        var samples = [];
        var staticPaths = [];
        for (var s = 0; s < siblings.length; s++) {
            var pp = siblings[s];
            var animated = false;
            try { animated = pp.numKeys >= 2; } catch (e) { }
            var kf0, kf1;
            if (animated) {
                kf0 = readPathSnapshot(pp.valueAtTime(pp.keyTime(1), false));
                kf1 = readPathSnapshot(pp.valueAtTime(pp.keyTime(2), false));
            } else {
                var staticVal = readPathSnapshot(pp.valueAtTime(t0, false));
                kf0 = staticVal; kf1 = staticVal;
                staticPaths.push(samples.length);
            }
            samples.push({ prop: pp, kf0: kf0, kf1: kf1, animated: animated });
        }

        // ── Determine the "main shape" centre (largest bbox at t0 amongst the
        //    animated paths). Used as the spawn point for collapsed dummies.
        var mainArea = -1, mainCenter = [0, 0];
        for (var s = 0; s < samples.length; s++) {
            if (!samples[s].animated) continue;
            var bb = pathBBoxCenter(samples[s].kf0);
            if (bb.area > mainArea) { mainArea = bb.area; mainCenter = bb.center; }
        }
        // Fallback: if every sibling is static, just use the first one's bbox.
        if (mainArea < 0 && samples.length) {
            var bb0 = pathBBoxCenter(samples[0].kf0);
            mainCenter = bb0.center;
        }

        // ── Force a single, consistent winding order across every keyframe.
        //    AE's Y-axis points down, so a visually-CW polygon has signedArea > 0.
        function forceCW(pd) {
            return signedArea(pd) < 0 ? reversePath(pd) : pd;
        }
        for (var s = 0; s < samples.length; s++) {
            samples[s].kf0 = forceCW(samples[s].kf0);
            samples[s].kf1 = forceCW(samples[s].kf1);
        }

        // ── Replace t0 keyframe of static siblings with a collapsed dummy at
        //    the main shape's centre — Lockwood's "grow from a single point" trick.
        for (var idx = 0; idx < staticPaths.length; idx++) {
            var sIdx = staticPaths[idx];
            var tgtPd = samples[sIdx].kf1;
            samples[sIdx].kf0 = collapsedDummyAt(tgtPd.vertices.length, tgtPd.closed,
                                                  mainCenter[0], mainCenter[1]);
        }

        // ── NW-align each pose pair (after lifting density to CFG.minVertices). ─
        var aligned = [];
        for (var s = 0; s < samples.length; s++) {
            var a = samples[s].kf0, b = samples[s].kf1;
            var preA = a.vertices.length >= CFG.minVertices ? a : normalizePath(a, CFG.minVertices);
            var preB = b.vertices.length >= CFG.minVertices ? b : normalizePath(b, CFG.minVertices);
            var nw = nwAlign(preA, preB);
            aligned.push({ prop: samples[s].prop, src: nw.src, tgt: nw.tgt });
        }

        // ── Write aligned data back. setValueAtTime updates the key at that
        //    exact time, so existing keyframes get overwritten in place.
        for (var s = 0; s < aligned.length; s++) {
            var e = aligned[s];
            e.prop.setValueAtTime(t0, aeShape(e.src));
            e.prop.setValueAtTime(t1, aeShape(e.tgt));
            applyEase(e.prop, t0, 75);
            applyEase(e.prop, t1, 75);
        }

        // ── Even-Odd fill on every fill in the container (no fills added). ────
        var fills = collectFillsInGroup(container);
        var fillsTouched = 0;
        for (var f = 0; f < fills.length; f++) {
            try { fills[f].property("ADBE Vector Fill Rule").setValue(2); fillsTouched++; } catch (e) { }
        }

        app.endUndoGroup();
        return { paths: aligned.length, fills: fillsTouched, grown: staticPaths.length };
    }


    // =========================================================================
    //  v3.0 REDESIGN  —  Super Morphings-style single-button workflow.
    //  - Auto-detects layer type and routes to path engine or rig engine
    //  - Modifier keys: Shift = pair morph, Alt = no anticipation
    //  - Controller null carries elastic params (no per-morph UI)
    //  - Single Morph button + Trails + Slice utility buttons
    // =========================================================================

    var V3 = {
        controllerName: "OpenMorph Controller",
        trails: {
            defaultCount: 5,
            defaultOffsetFrames: 3,
            defaultColor: [1, 1, 1],
            defaultRandom: 10
        },
        slice: { defaultCount: 4 },
        rig: {
            squashScale: 0.8,
            preTiltDegrees: 25,
            durationFrames: { preLaunch: 4, travel: 16, scaleLag: 2, rotationLag: 4 },
            staggerFrames: 3,
            elastic: { amplitude: 50, frequency: 2.5, decay: 5 },
            ease: {
                holdLaunch: [0, 33],
                arrival:    [0, 100],
                scale:      [0, 33],
                rotation:   [0, 33]
            }
        },
        pathDurationSec: 1.5
    };

    // ── selection helpers ───────────────────────────────────────────────────
    function v3GetComp() {
        var it = app.project.activeItem;
        return (it && it instanceof CompItem) ? it : null;
    }
    function v3GetSelection(comp) {
        var sel = comp.selectedLayers;
        if (sel.length < 2) return null;
        return { sources: sel.slice(0, sel.length - 1), target: sel[sel.length - 1], all: sel };
    }
    function v3AllShapes(layers) {
        for (var i = 0; i < layers.length; i++) {
            if (!(layers[i] instanceof ShapeLayer)) return false;
        }
        return true;
    }
    function v3ModifierState() {
        var ks = ScriptUI.environment.keyboardState;
        return { shift: !!ks.shiftKey, alt: !!ks.altKey, ctrl: !!(ks.ctrlKey || ks.metaKey) };
    }

    // ── layer management (shared by rig + utilities) ────────────────────────
    function v3CenterAnchor(layer) {
        var t  = layer.containingComp.time;
        var b  = layer.sourceRectAtTime(t, false);
        var na = [b.left + b.width / 2, b.top + b.height / 2];
        var oa = layer.transform.anchorPoint.value;
        var sc = layer.transform.scale.value;
        var po = layer.transform.position.value;
        layer.transform.anchorPoint.setValue(na);
        layer.transform.position.setValue([
            po[0] + (na[0] - oa[0]) * sc[0] / 100,
            po[1] + (na[1] - oa[1]) * sc[1] / 100
        ]);
    }
    function v3Unseparate(p) { if (p.dimensionsSeparated) p.dimensionsSeparated = false; }
    function v3MoveToTop(l) { if (l.index !== 1) l.moveToBeginning(); }
    function v3SetEase(prop, keyIdx, pair) {
        var dim = (prop.value.length || 1);
        var arr = [];
        for (var d = 0; d < dim; d++) arr.push(new KeyframeEase(pair[0], pair[1]));
        prop.setTemporalEaseAtKey(keyIdx, arr, arr);
    }

    // ── controller null (single, shared) ────────────────────────────────────
    function v3GetOrBuildController(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i).name === V3.controllerName) return comp.layer(i);
        }
        var n = comp.layers.addNull();
        n.name = V3.controllerName;
        n.label = 9;
        n.guideLayer = true;
        var fx = n.property("Effects");
        function slider(name, def) {
            var s = fx.addProperty("ADBE Slider Control");
            s.name = name;
            s.property("Slider").setValue(def);
        }
        slider("Amplitude", V3.rig.elastic.amplitude);
        slider("Frequency", V3.rig.elastic.frequency);
        slider("Decay",     V3.rig.elastic.decay);
        return n;
    }
    function v3ElasticExpr(ctrlName) {
        var c = 'thisComp.layer("' + ctrlName + '").effect';
        return [
            "try {",
            "  amp   = " + c + '("Amplitude")("Slider") / 100;',
            "  freq  = " + c + '("Frequency")("Slider");',
            "  decay = " + c + '("Decay")("Slider");',
            "  n = 0;",
            "  if (numKeys > 0) {",
            "    n = nearestKey(time).index;",
            "    if (key(n).time > time) n--;",
            "  }",
            "  if (n > 0) {",
            "    t = time - key(n).time;",
            "    v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
            "    value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);",
            "  } else value;",
            "} catch (e) { value; }"
        ].join("\n");
    }

    // ── rig morph: one source → target ──────────────────────────────────────
    function v3RigBuildSource(layer, target, time, dur, ctrl,
                              tPos, tRot, tScale, tBounds, isFirst, useAnticipation) {
        v3CenterAnchor(layer);
        var pos = layer.transform.position;
        var sc  = layer.transform.scale;
        var rt  = layer.transform.rotation;
        var op  = layer.transform.opacity;
        v3Unseparate(pos);

        var cp = pos.value, cs = sc.value, cr = rt.value;
        var b  = layer.sourceRectAtTime(time, false);

        // POSITION: with anticipation = [hold, hold, fly]; without = [now, fly]
        var pT, pV, arrivalKey;
        if (useAnticipation) {
            pT = [time, time + dur.preLaunch, time + dur.travel];
            pV = [cp, cp, tPos];
            arrivalKey = 3;
        } else {
            pT = [time, time + dur.travel];
            pV = [cp, tPos];
            arrivalKey = 2;
        }
        pos.setValuesAtTimes(pT, pV);
        v3SetEase(pos, 1, V3.rig.ease.holdLaunch);
        if (useAnticipation) v3SetEase(pos, 2, V3.rig.ease.holdLaunch);
        v3SetEase(pos, arrivalKey, V3.rig.ease.arrival);

        // SCALE: current → (squash) → match target visible size
        var newSc = [
            b.width  > 0 ? tScale[0] * tBounds.width  / b.width  : cs[0],
            b.height > 0 ? tScale[1] * tBounds.height / b.height : cs[1]
        ];
        var sT, sV;
        if (useAnticipation) {
            sT = [time, time + dur.preLaunch + dur.scaleLag, time + dur.travel];
            sV = [cs, [cs[0] * V3.rig.squashScale, cs[1] * V3.rig.squashScale], newSc];
        } else {
            sT = [time, time + dur.travel];
            sV = [cs, newSc];
        }
        sc.setValuesAtTimes(sT, sV);
        for (var k = 1; k <= sT.length; k++) v3SetEase(sc, k, V3.rig.ease.scale);

        // ROTATION: pre-tilt then settle (only with anticipation)
        var rT, rV;
        if (useAnticipation) {
            var dir = (tPos[0] - cp[0]) >= 0 ? 1 : -1;
            rT = [time, time + dur.preLaunch + dur.rotationLag, time + dur.travel];
            rV = [cr, cr + dir * V3.rig.preTiltDegrees, tRot];
        } else {
            rT = [time, time + dur.travel];
            rV = [cr, tRot];
        }
        rt.setValuesAtTimes(rT, rV);
        for (var k2 = 1; k2 <= rT.length; k2++) v3SetEase(rt, k2, V3.rig.ease.rotation);

        // OPACITY HANDOFF
        op.expression =
            "try { if (time < transform.position.key(" + arrivalKey + ").time) 100; else 0; }" +
            " catch (e) { value; }";
        if (isFirst) {
            target.transform.opacity.expression =
                'try { 100 - thisComp.layer("' + layer.name + '").transform.opacity }' +
                " catch (e) { value; }";
        }

        // ELASTIC OVERSHOOT
        var elx = v3ElasticExpr(ctrl.name);
        pos.expression = elx;
        sc.expression  = elx;
        rt.expression  = elx;
    }

    function v3ApplyTargetTracking(target, sources) {
        var lines = [];
        for (var i = 0; i < sources.length; i++) {
            lines.push('  thisComp.layer("' + sources[i].name + '")');
        }
        var srcList = lines.join(",\n");
        function expr(propName) {
            return [
                "try {",
                "  var srcs = [", srcList, "  ];",
                "  var off = 0;",
                "  for (var i = 0; i < srcs.length; i++) {",
                "    var p = srcs[i].transform." + propName + ";",
                "    if (p.numKeys > 0 && time > p.key(1).time) {",
                "      off += (p.value - p.key(1).value) / srcs.length;",
                "    }",
                "  }",
                "  value + off;",
                "} catch (e) { value; }"
            ].join("\n");
        }
        target.transform.position.expression = expr("position");
        target.transform.scale.expression    = expr("scale");
        target.transform.rotation.expression = expr("rotation");
    }

    // ── ENGINE: rig morph all-into-last ─────────────────────────────────────
    function v3RunRigMorph(comp, sel, useAnticipation) {
        var f = comp.frameDuration;
        var dur = {};
        for (var k in V3.rig.durationFrames) dur[k] = f * V3.rig.durationFrames[k];
        var stagger = f * V3.rig.staggerFrames;

        var ctrl = v3GetOrBuildController(comp);
        v3MoveToTop(sel.target);
        v3CenterAnchor(sel.target);
        v3Unseparate(sel.target.transform.position);

        var t0      = comp.time;
        var tPos    = sel.target.transform.position.valueAtTime(t0, false);
        var tRot    = sel.target.transform.rotation.valueAtTime(t0, false);
        var tScale  = sel.target.transform.scale.value;
        var tBounds = sel.target.sourceRectAtTime(t0, false);

        v3ApplyTargetTracking(sel.target, sel.sources);

        for (var i = 0; i < sel.sources.length; i++) {
            v3RigBuildSource(sel.sources[i], sel.target,
                             t0 + i * stagger, dur, ctrl,
                             tPos, tRot, tScale, tBounds, i === 0, useAnticipation);
        }
    }

    // ── ENGINE: pair morph (Shift+Click) — pairs (0,1), (2,3), ... ──────────
    function v3RunPairMorph(comp, layers, useAnticipation) {
        var f = comp.frameDuration;
        var dur = {};
        for (var k in V3.rig.durationFrames) dur[k] = f * V3.rig.durationFrames[k];
        var pairStagger = f * V3.rig.staggerFrames * 2;
        var ctrl = v3GetOrBuildController(comp);
        var t0 = comp.time;

        for (var p = 0; p + 1 < layers.length; p += 2) {
            var src = layers[p], tgt = layers[p + 1];
            v3MoveToTop(tgt);
            v3CenterAnchor(tgt);
            v3Unseparate(tgt.transform.position);
            var tPos = tgt.transform.position.valueAtTime(t0, false);
            var tRot = tgt.transform.rotation.valueAtTime(t0, false);
            var tScale = tgt.transform.scale.value;
            var tBounds = tgt.sourceRectAtTime(t0, false);
            v3ApplyTargetTracking(tgt, [src]);
            v3RigBuildSource(src, tgt, t0 + (p / 2) * pairStagger,
                             dur, ctrl, tPos, tRot, tScale, tBounds, true, useAnticipation);
        }
    }

    // ── ENGINE: path morph (delegates to existing execSingle) ───────────────
    function v3RunPathMorph(comp, sel) {
        if (sel.all.length !== 2) {
            alert("Path morph requires exactly 2 shape layers.\nSelect source, then target.");
            return false;
        }
        SINGLE.srcLayer = sel.sources[0];
        SINGLE.tgtLayer = sel.target;
        SINGLE.srcPaths = getAllPaths(SINGLE.srcLayer);
        SINGLE.tgtPaths = getAllPaths(SINGLE.tgtLayer);
        CFG.duration = V3.pathDurationSec;
        CFG.easing = 33;
        CFG.matchPosition = true;
        return execSingle();
    }

    // ── ENGINE: trails (live expression-driven shape echoes) ────────────────
    function v3RunTrails() {
        var comp = v3GetComp();
        if (!comp) { alert("Open a composition."); return; }
        var sel = comp.selectedLayers;
        if (!sel.length) { alert("Select 1+ animated layer to trail."); return; }

        app.beginUndoGroup("OpenMorph: Trails");
        try {
            for (var i = 0; i < sel.length; i++) v3BuildTrailLayer(comp, sel[i]);
        } catch (e) {
            alert("Trails error: " + e.toString());
        }
        app.endUndoGroup();
    }
    function v3BuildTrailLayer(comp, srcLayer) {
        var trail = comp.layers.addShape();
        trail.name = srcLayer.name + " Trails";
        trail.label = 13;
        trail.moveAfter(srcLayer);
        // Reset trail layer to comp origin so group-space == comp-space in expressions
        trail.transform.position.setValue([0, 0]);
        trail.transform.anchorPoint.setValue([0, 0]);

        // controller effects on the trail layer itself
        var fx = trail.property("Effects");
        var colorFx = fx.addProperty("ADBE Color Control"); colorFx.name = "Trail Color";
        colorFx.property("Color").setValue(V3.trails.defaultColor);
        var countFx = fx.addProperty("ADBE Slider Control"); countFx.name = "Trail Count";
        countFx.property("Slider").setValue(V3.trails.defaultCount);
        var offFx   = fx.addProperty("ADBE Slider Control"); offFx.name = "Time Offset";
        offFx.property("Slider").setValue(V3.trails.defaultOffsetFrames);
        var randFx  = fx.addProperty("ADBE Slider Control"); randFx.name = "Random Spread";
        randFx.property("Slider").setValue(V3.trails.defaultRandom);
        var seedFx  = fx.addProperty("ADBE Slider Control"); seedFx.name = "Random Seed";
        seedFx.property("Slider").setValue(1);

        // build N ellipses; each samples srcLayer's position at time - i*offset
        var root = trail.property("ADBE Root Vectors Group");
        var srcName = srcLayer.name;
        for (var i = 1; i <= V3.trails.defaultCount; i++) {
            var grp = root.addProperty("ADBE Vector Group");
            grp.name = "Echo " + i;
            var contents = grp.property("ADBE Vectors Group");
            var ell = contents.addProperty("ADBE Vector Shape - Ellipse");
            ell.property("ADBE Vector Ellipse Size").setValue([20, 20]);
            var fill = contents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").expression =
                'effect("Trail Color")("Color")';

            // group transform: position = src position N frames ago + random offset
            var gT = grp.property("ADBE Vector Transform Group");
            gT.property("ADBE Vector Position").expression = [
                "try {",
                "  var src = thisComp.layer(\"" + srcName + "\");",
                "  var off = effect(\"Time Offset\")(\"Slider\");",
                "  var i   = " + i + ";",
                "  var p   = src.toComp(src.transform.position.valueAtTime(time - i * off * thisComp.frameDuration));",
                "  seedRandom(effect(\"Random Seed\")(\"Slider\") + i, true);",
                "  var spread = effect(\"Random Spread\")(\"Slider\");",
                "  p + [random(-spread, spread), random(-spread, spread)] - position;",
                "} catch (e) { [0, 0]; }"
            ].join("\n");

            // opacity fades with index (older echoes more transparent)
            gT.property("ADBE Vector Group Opacity").expression =
                "var n = effect(\"Trail Count\")(\"Slider\"); " +
                "var i = " + i + "; if (i > n) 0; else 100 * (1 - (i-1)/n);";
        }
    }

    // ── ENGINE: slice (cut layer into N vertical strips via track mattes) ───
    function v3RunSlice() {
        var comp = v3GetComp();
        if (!comp) { alert("Open a composition."); return; }
        var sel = comp.selectedLayers;
        if (!sel.length) { alert("Select 1+ layer to slice."); return; }

        var input = prompt("How many slices?", String(V3.slice.defaultCount));
        var n = parseInt(input, 10);
        if (!n || n < 2) return;

        app.beginUndoGroup("OpenMorph: Slice");
        try {
            for (var i = 0; i < sel.length; i++) v3SliceOne(comp, sel[i], n);
        } catch (e) {
            alert("Slice error: " + e.toString());
        }
        app.endUndoGroup();
    }
    function v3SliceOne(comp, layer, n) {
        if (layer.hasVideo === false) return;
        var t = comp.time;
        var b = layer.sourceRectAtTime(t, true);
        if (!b || b.width <= 0) return;
        var sliceW = b.width / n;

        // hide original, build N duplicates each masked to its strip
        layer.enabled = false;
        for (var i = 0; i < n; i++) {
            var dup = layer.duplicate();
            dup.enabled = true;
            dup.name = layer.name + " slice " + (i + 1);
            dup.moveAfter(layer);

            var mask = dup.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
            mask.name = "Strip " + (i + 1);
            var x0 = b.left + i * sliceW;
            var x1 = x0 + sliceW;
            var y0 = b.top;
            var y1 = b.top + b.height;

            var shape = new Shape();
            shape.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            shape.inTangents  = [[0,0],[0,0],[0,0],[0,0]];
            shape.outTangents = [[0,0],[0,0],[0,0],[0,0]];
            shape.closed = true;
            mask.property("ADBE Mask Shape").setValue(shape);
            mask.property("ADBE Mask Mode").setValue(MaskMode.ADD);
        }
    }

    // ── MAIN ENTRY POINT (routed from the Morph button) ─────────────────────
    function v3OnMorphClick() {
        var comp = v3GetComp();
        if (!comp) { alert("Open a composition first."); return; }
        var sel = v3GetSelection(comp);
        if (!sel) { alert("Select 2 or more layers (last = target)."); return; }

        var mod = v3ModifierState();
        var useAnticipation = !mod.alt;

        app.beginUndoGroup("OpenMorph: Build");
        try {
            if (mod.shift) {
                // Pair morph: (0,1), (2,3), ...
                if (sel.all.length < 2 || sel.all.length % 2 !== 0) {
                    alert("Pair morph needs an even number of layers (2, 4, 6...).");
                } else {
                    v3RunPairMorph(comp, sel.all, useAnticipation);
                }
            } else if (v3AllShapes(sel.all)) {
                v3RunPathMorph(comp, sel);
            } else {
                v3RunRigMorph(comp, sel, useAnticipation);
            }
        } catch (e) {
            alert("OpenMorph error: " + e.toString());
        }
        app.endUndoGroup();
    }

    // =========================================================================
    //  UI  —  Minimal single-button panel
    // =========================================================================
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "OpenMorph Pro", undefined, { resizeable: false });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 6;
        win.margins = [10, 10, 10, 10];

        // header
        var hdr = win.add("group");
        hdr.orientation = "row"; hdr.alignChildren = ["left", "center"]; hdr.spacing = 6;
        var titleEl = hdr.add("statictext", undefined, "◆ OpenMorph Pro");
        titleEl.graphics.font = ScriptUI.newFont("Arial", "BOLD", 13);
        var verEl = hdr.add("statictext", undefined, "v3.0");
        try { verEl.graphics.foregroundColor = verEl.graphics.newPen(verEl.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55, 1], 1); } catch (e) {}

        // hint line
        var hint = win.add("statictext", undefined, "Select layers → last is target → Morph");
        hint.alignment = ["fill", "top"];

        // BIG MORPH BUTTON
        var morphBtn = win.add("button", undefined, "MORPH IT");
        morphBtn.preferredSize.height = 44;
        morphBtn.onClick = v3OnMorphClick;

        // modifier-key cheat sheet
        var cheat = win.add("statictext", undefined,
            "Shift = pair morph     Alt = no anticipation", { multiline: true });
        cheat.alignment = ["fill", "top"];

        // utility row: Trails + Slice
        var utilRow = win.add("group");
        utilRow.alignment = ["fill", "top"];
        utilRow.spacing = 4;
        var trailsBtn = utilRow.add("button", undefined, "Trails");
        trailsBtn.alignment = ["fill", "center"];
        trailsBtn.onClick = v3RunTrails;
        var sliceBtn  = utilRow.add("button", undefined, "Slice");
        sliceBtn.alignment = ["fill", "center"];
        sliceBtn.onClick = v3RunSlice;

        // post-morph helpers (kept from v2 — operate on already-built morphs)
        var postRow = win.add("group");
        postRow.alignment = ["fill", "top"];
        postRow.spacing = 4;
        var optBtn  = postRow.add("button", undefined, "Fix Bool");
        optBtn.helpTip = "Re-align vertex order on N→M morph keys";
        optBtn.onClick = function () { try { optimizeBooleanKeys(); } catch (e) { alert(e); } };
        var revBtn  = postRow.add("button", undefined, "Reverse");
        revBtn.helpTip = "Reverse target path vertex order";
        revBtn.onClick = function () {
            var l = getSelectedShapeLayer();
            if (l) reverseTargetPaths(l); else alert("Select a shape layer.");
        };
        var nudgeBtn = postRow.add("button", undefined, "Nudge");
        nudgeBtn.helpTip = "Shift start vertex +1";
        nudgeBtn.onClick = function () {
            var l = getSelectedShapeLayer();
            if (l) nudgeTargetPaths(l); else alert("Select a shape layer.");
        };
        var bakeBtn  = postRow.add("button", undefined, "Bake");
        bakeBtn.helpTip = "Bake controller values onto render layer";
        bakeBtn.onClick = function () { try { bakeSelected(); } catch (e) { alert(e); } };

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); }
        return win;
    }

    buildUI(thisObj);

})(this);
