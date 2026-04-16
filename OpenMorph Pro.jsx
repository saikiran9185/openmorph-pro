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
    //  UI  —  Compact Tabbed Panel
    //  Three tabs: Single / Chain / Multi
    //  Numbered steps (① ②) guide the user through each workflow
    // =========================================================================
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "OpenMorph Pro", undefined, { resizeable: false });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 4;
        win.margins = [8, 8, 8, 8];

        // ─── color helpers ────────────────────────────────────────────────────
        var C = {
            green: [0.22, 0.82, 0.45],
            orange: [1.00, 0.60, 0.20],
            blue: [0.35, 0.65, 1.00],
            red: [0.90, 0.22, 0.22],
            gray: [0.55, 0.55, 0.55],
            yellow: [0.90, 0.80, 0.10],
            teal: [0.20, 0.80, 0.80]
        };

        function pen(el, rgb) {
            try { el.graphics.foregroundColor = el.graphics.newPen(el.graphics.PenType.SOLID_COLOR, [rgb[0], rgb[1], rgb[2], 1], 1); } catch (e) { }
        }

        // ─── HEADER ──────────────────────────────────────────────────────────
        var hdr = win.add("group");
        hdr.orientation = "row"; hdr.alignChildren = ["left", "center"]; hdr.spacing = 5;

        var titleEl = hdr.add("statictext", undefined, "\u25C6 OpenMorph Pro");
        titleEl.graphics.font = ScriptUI.newFont("Arial", "BOLD", 13);

        var verEl = hdr.add("statictext", undefined, "v" + VERSION);
        pen(verEl, C.gray);

        // ─── NATIVE TABBED PANEL ─────────────────────────────────────────────
        var tp = win.add("tabbedpanel");
        tp.alignChildren = ["fill", "fill"];
        tp.preferredSize.width = 290;

        // ══════════════════════════════════════════════════════════════════════
        //  TAB CONTENT  ①  SINGLE
        //  Compact 2-row layout: FROM row + TO row + swap + mode badge
        // ══════════════════════════════════════════════════════════════════════
        var sTab = tp.add("tab", undefined, "\u25C8 Single");
        sTab.orientation = "column"; sTab.alignChildren = ["fill", "top"];
        sTab.margins = [6, 8, 6, 6]; sTab.spacing = 5;

        // ① FROM row
        var fromRow = sTab.add("group");
        fromRow.orientation = "row"; fromRow.alignChildren = ["left", "center"]; fromRow.spacing = 5;
        var fromIcon = fromRow.add("statictext", undefined, "\u2460");
        pen(fromIcon, C.green);
        fromRow.add("statictext", undefined, "FROM");
        var srcLbl = fromRow.add("statictext", undefined, "[ not set ]");
        srcLbl.preferredSize.width = 108; pen(srcLbl, C.gray);
        var setSrcBtn = fromRow.add("button", undefined, "\u25B6 Set"); setSrcBtn.preferredSize.width = 44;

        var srcInfoLbl = sTab.add("statictext", undefined, "     \u2514 select a Shape Layer, then click Set");
        pen(srcInfoLbl, C.gray);

        sTab.add("panel", undefined, "").preferredSize.height = 1; // thin divider

        // ② TO row
        var toRow = sTab.add("group");
        toRow.orientation = "row"; toRow.alignChildren = ["left", "center"]; toRow.spacing = 5;
        var toIcon = toRow.add("statictext", undefined, "\u2461");
        pen(toIcon, C.orange);
        toRow.add("statictext", undefined, "  TO ");
        var tgtLbl = toRow.add("statictext", undefined, "[ not set ]");
        tgtLbl.preferredSize.width = 108; pen(tgtLbl, C.gray);
        var setTgtBtn = toRow.add("button", undefined, "\u25B6 Set"); setTgtBtn.preferredSize.width = 44;

        var tgtInfoLbl = sTab.add("statictext", undefined, "     \u2514 select a Shape Layer, then click Set");
        pen(tgtInfoLbl, C.gray);

        // Swap + mode badge
        var sBotRow = sTab.add("group"); sBotRow.orientation = "row"; sBotRow.alignChildren = ["left", "center"]; sBotRow.spacing = 8;
        var swapBtn = sBotRow.add("button", undefined, "\u21C4 Swap"); swapBtn.preferredSize.width = 54;
        var modeBadge = sBotRow.add("statictext", undefined, ""); modeBadge.alignment = ["fill", "center"];

        // ══════════════════════════════════════════════════════════════════════
        //  TAB CONTENT  ②  CHAIN   A → B → C → D on ONE render layer
        // ══════════════════════════════════════════════════════════════════════
        var cTab = tp.add("tab", undefined, "\u21C6 Chain");
        cTab.orientation = "column"; cTab.alignChildren = ["fill", "top"];
        cTab.margins = [6, 8, 6, 6]; cTab.spacing = 4;

        var cHint = cTab.add("statictext", undefined, "\u2460 Select layer \u2192 Add Step  (repeat for each shape)");
        pen(cHint, C.gray);

        var chainList = cTab.add("listbox", undefined, [], { multiselect: false });
        chainList.preferredSize.height = 75;

        var cRow1 = cTab.add("group"); cRow1.orientation = "row"; cRow1.alignChildren = ["fill", "center"]; cRow1.spacing = 3;
        var cAddBtn = cRow1.add("button", undefined, "+ Add Step"); cAddBtn.preferredSize.width = 76;
        var cRemBtn = cRow1.add("button", undefined, "\u2212 Remove");
        var cUpBtn = cRow1.add("button", undefined, "\u2191"); cUpBtn.preferredSize.width = 26;
        var cDnBtn = cRow1.add("button", undefined, "\u2193"); cDnBtn.preferredSize.width = 26;

        var cRow2 = cTab.add("group"); cRow2.orientation = "row"; cRow2.alignChildren = ["left", "center"]; cRow2.spacing = 4;
        cRow2.add("statictext", undefined, "\u2461 Selected step duration:");
        var stepDurEdit = cRow2.add("edittext", undefined, "1.5"); stepDurEdit.preferredSize.width = 34;
        cRow2.add("statictext", undefined, "s");

        var cStatusLbl = cTab.add("statictext", undefined, "Add 2+ steps, then Create.");
        pen(cStatusLbl, C.gray);

        // ══════════════════════════════════════════════════════════════════════
        //  TAB CONTENT  ③  MULTI   each pair = own render layer + timing
        // ══════════════════════════════════════════════════════════════════════
        var mTab = tp.add("tab", undefined, "\u2295 Multi");
        mTab.orientation = "column"; mTab.alignChildren = ["fill", "top"];
        mTab.margins = [6, 8, 6, 6]; mTab.spacing = 4;

        var mHint = mTab.add("statictext", undefined, "\u2460 Add a pair, select it, then Set Src and Set Tgt");
        pen(mHint, C.gray);

        var multiList = mTab.add("listbox", undefined, [], { multiselect: false });
        multiList.preferredSize.height = 66;

        var mRow1 = mTab.add("group"); mRow1.orientation = "row"; mRow1.alignChildren = ["fill", "center"]; mRow1.spacing = 3;
        var mAddBtn = mRow1.add("button", undefined, "+ Pair"); mAddBtn.preferredSize.width = 52;
        var mRemBtn = mRow1.add("button", undefined, "\u2212"); mRemBtn.preferredSize.width = 30;
        var mSrcBtn = mRow1.add("button", undefined, "\u25B6 Src");
        var mTgtBtn = mRow1.add("button", undefined, "\u25B6 Tgt");

        var mRow2 = mTab.add("group"); mRow2.orientation = "row"; mRow2.alignChildren = ["left", "center"]; mRow2.spacing = 4;
        mRow2.add("statictext", undefined, "\u2461 Start:");
        var mStartEdit = mRow2.add("edittext", undefined, "0.0"); mStartEdit.preferredSize.width = 30;
        mRow2.add("statictext", undefined, "s");
        mRow2.add("statictext", undefined, "  Dur:");
        var mDurEdit = mRow2.add("edittext", undefined, "1.5"); mDurEdit.preferredSize.width = 30;
        mRow2.add("statictext", undefined, "s  (selected pair)");

        var mStatusLbl = mTab.add("statictext", undefined, "");
        pen(mStatusLbl, C.gray);

        // ══════════════════════════════════════════════════════════════════════
        //  SETTINGS ROW  (compact, always visible)
        // ══════════════════════════════════════════════════════════════════════
        var setRow = win.add("group"); setRow.orientation = "row"; setRow.alignChildren = ["left", "center"]; setRow.spacing = 4;
        setRow.add("statictext", undefined, "\u23F1");
        var durSlider = setRow.add("slider", undefined, 1.5, 0.1, 10); durSlider.preferredSize.width = 76;
        var durEdit = setRow.add("edittext", undefined, "1.5"); durEdit.preferredSize.width = 28;
        setRow.add("statictext", undefined, "s");
        var easeDrop = setRow.add("dropdownlist", undefined, ["Linear", "Easy", "Expo"]);
        easeDrop.selection = 1; easeDrop.preferredSize.width = 54;
        var travelChk = setRow.add("checkbox", undefined, "\u21C4 Pos"); travelChk.value = true;

        durSlider.onChanging = function () { durEdit.text = durSlider.value.toFixed(1); CFG.duration = durSlider.value; };
        durEdit.onChange = function () { var v = parseFloat(durEdit.text); if (!isNaN(v)) { v = Math.max(0.1, Math.min(10, v)); durSlider.value = v; durEdit.text = v.toFixed(1); CFG.duration = v; } };
        easeDrop.onChange = function () { CFG.easing = [0, 33, 90][easeDrop.selection.index]; };
        travelChk.onClick = function () { CFG.matchPosition = travelChk.value; };

        // ══════════════════════════════════════════════════════════════════════
        //  STATUS + ACTION
        // ══════════════════════════════════════════════════════════════════════
        var statRow = win.add("group"); statRow.orientation = "row"; statRow.alignChildren = ["left", "center"]; statRow.spacing = 4;
        var dot = statRow.add("statictext", undefined, "\u25CF");
        var statLbl = statRow.add("statictext", undefined, "Ready"); statLbl.alignment = ["fill", "center"];

        function setStatus(msg, rgb) { statLbl.text = msg; pen(dot, rgb || C.gray); }

        var morphBtn = win.add("button", undefined, "  CREATE MORPH  \u2192");
        morphBtn.preferredSize.height = 32;

        // ══════════════════════════════════════════════════════════════════════
        //  POST-MORPH TOOLS  (tiny row at bottom)
        // ══════════════════════════════════════════════════════════════════════
        var postRow = win.add("group"); postRow.orientation = "row"; postRow.alignChildren = ["fill", "center"]; postRow.spacing = 3;
        var revBtn = postRow.add("button", undefined, "\u21BA Reverse");
        var nudgeBtn = postRow.add("button", undefined, "\u21C0 Nudge");
        var bakeBtn = postRow.add("button", undefined, "\u2606 Bake");

        // ══════════════════════════════════════════════════════════════════════
        //  TAB SWITCHING  (native tabbedpanel handles visibility/height)
        // ══════════════════════════════════════════════════════════════════════
        var tabStatusMessages = ["From \u2192 To \u2192 Create",
            "Add Steps \u2192 Create",
            "Add Pairs \u2192 Create"];
        tp.onChange = function () {
            var idx = tp.selection.index;
            SESSION.mode = ["single", "chain", "multi"][idx];
            setStatus(tabStatusMessages[idx], C.gray);
        };

        // ══════════════════════════════════════════════════════════════════════
        //  SINGLE  handlers
        // ══════════════════════════════════════════════════════════════════════
        function updateBadge() {
            if (!SINGLE.srcLayer || !SINGLE.tgtLayer) { modeBadge.text = ""; return; }
            var sc = SINGLE.srcPaths.length, tc = SINGLE.tgtPaths.length;
            if (sc === tc) { modeBadge.text = "1:1 \u2022 " + sc + "p"; pen(modeBadge, C.green); }
            else if (sc < tc) { modeBadge.text = "SPLIT " + sc + "\u2192" + tc + "p"; pen(modeBadge, C.orange); }
            else { modeBadge.text = "MERGE " + sc + "\u2192" + tc + "p"; pen(modeBadge, C.blue); }
        }

        setSrcBtn.onClick = function () {
            var l = getSelectedShapeLayer();
            if (!l) { setStatus("Select a Shape Layer in the AE timeline first.", C.red); return; }
            convertToBezier(l); l.label = LBL_GREEN;
            SINGLE.srcLayer = l; SINGLE.srcPaths = getAllPaths(l);
            srcLbl.text = l.name.substring(0, 18) + (l.name.length > 18 ? "\u2026" : "");
            pen(srcLbl, C.green);
            srcInfoLbl.text = "     \u2514 " + SINGLE.srcPaths.length + " path(s) \u2713 (green label set)";
            pen(srcInfoLbl, C.green);
            updateBadge();
            if (SINGLE.tgtLayer) setStatus("Ready! Hit Create Morph.", C.green);
            else setStatus("FROM set. Now set \u2461 TO.", C.yellow);
            if (win instanceof Window) win.layout.layout(true); // only in standalone float; breaks docked panels
        };

        setTgtBtn.onClick = function () {
            var l = getSelectedShapeLayer();
            if (!l) { setStatus("Select a Shape Layer in the AE timeline first.", C.red); return; }
            convertToBezier(l); l.label = LBL_ORANGE;
            SINGLE.tgtLayer = l; SINGLE.tgtPaths = getAllPaths(l);
            tgtLbl.text = l.name.substring(0, 18) + (l.name.length > 18 ? "\u2026" : "");
            pen(tgtLbl, C.orange);
            tgtInfoLbl.text = "     \u2514 " + SINGLE.tgtPaths.length + " path(s) \u2713 (orange label set)";
            pen(tgtInfoLbl, C.orange);
            updateBadge();
            if (SINGLE.srcLayer) setStatus("Ready! Hit Create Morph.", C.green);
            else setStatus("TO set. Now set \u2460 FROM.", C.yellow);
            if (win instanceof Window) win.layout.layout(true); // only in standalone float; breaks docked panels
        };

        swapBtn.onClick = function () {
            var tl = SINGLE.srcLayer; SINGLE.srcLayer = SINGLE.tgtLayer; SINGLE.tgtLayer = tl;
            var tp = SINGLE.srcPaths; SINGLE.srcPaths = SINGLE.tgtPaths; SINGLE.tgtPaths = tp;
            var tn;
            tn = srcLbl.text; srcLbl.text = tgtLbl.text; tgtLbl.text = tn;
            tn = srcInfoLbl.text; srcInfoLbl.text = tgtInfoLbl.text; tgtInfoLbl.text = tn;
            pen(srcLbl, SINGLE.srcLayer ? C.green : C.gray);
            pen(srcInfoLbl, SINGLE.srcLayer ? C.green : C.gray);
            pen(tgtLbl, SINGLE.tgtLayer ? C.orange : C.gray);
            pen(tgtInfoLbl, SINGLE.tgtLayer ? C.orange : C.gray);
            updateBadge();
        };

        // ══════════════════════════════════════════════════════════════════════
        //  CHAIN  handlers
        // ══════════════════════════════════════════════════════════════════════
        function refreshChain() {
            chainList.removeAll();
            for (var i = 0; i < CHAIN.steps.length; i++) {
                var s = CHAIN.steps[i];
                var tag = i === 0 ? "START " : i === CHAIN.steps.length - 1 ? "END   " : "  \u2193   ";
                chainList.add("item", tag + " " + s.label + " \u00B7 " + s.duration.toFixed(1) + "s");
            }
            var n = CHAIN.steps.length;
            if (n < 2) { cStatusLbl.text = "Add " + (2 - n) + " more step(s) to enable."; pen(cStatusLbl, C.gray); }
            else {
                var tot = 0; for (var i = 0; i < n - 1; i++) tot += CHAIN.steps[i].duration;
                cStatusLbl.text = n + " steps \u00B7 " + tot.toFixed(1) + "s total \u2713 ready";
                pen(cStatusLbl, C.green);
            }
        }

        cAddBtn.onClick = function () {
            var l = getSelectedShapeLayer();
            if (!l) { setStatus("Select a Shape Layer in the timeline.", C.red); return; }
            convertToBezier(l); l.label = LBL_CHAIN;
            var paths = getAllPaths(l);
            var dur = parseFloat(stepDurEdit.text) || CFG.duration;
            CHAIN.steps.push({ layer: l, paths: paths, label: l.name.substring(0, 14) + " (" + paths.length + "p)", duration: dur });
            refreshChain();
            setStatus("Step " + CHAIN.steps.length + " added: " + l.name, C.blue);
        };

        cRemBtn.onClick = function () {
            var idx = chainList.selection ? chainList.selection.index : -1;
            if (idx < 0) { setStatus("Select a step to remove.", C.gray); return; }
            CHAIN.steps.splice(idx, 1); refreshChain(); setStatus("Step removed.", C.gray);
        };

        cUpBtn.onClick = function () {
            var idx = chainList.selection ? chainList.selection.index : -1;
            if (idx < 1) return;
            var t = CHAIN.steps[idx - 1]; CHAIN.steps[idx - 1] = CHAIN.steps[idx]; CHAIN.steps[idx] = t;
            refreshChain(); chainList.selection = idx - 1;
        };

        cDnBtn.onClick = function () {
            var idx = chainList.selection ? chainList.selection.index : -1;
            if (idx < 0 || idx >= CHAIN.steps.length - 1) return;
            var t = CHAIN.steps[idx + 1]; CHAIN.steps[idx + 1] = CHAIN.steps[idx]; CHAIN.steps[idx] = t;
            refreshChain(); chainList.selection = idx + 1;
        };

        stepDurEdit.onChange = function () {
            var idx = chainList.selection ? chainList.selection.index : -1; if (idx < 0) return;
            var v = parseFloat(stepDurEdit.text); if (!isNaN(v) && v > 0) { CHAIN.steps[idx].duration = v; refreshChain(); }
        };

        chainList.onChange = function () {
            var idx = chainList.selection ? chainList.selection.index : -1;
            if (idx >= 0) stepDurEdit.text = (CHAIN.steps[idx].duration || CFG.duration).toFixed(1);
        };

        // ══════════════════════════════════════════════════════════════════════
        //  MULTI  handlers
        // ══════════════════════════════════════════════════════════════════════
        function refreshMulti() {
            multiList.removeAll();
            for (var i = 0; i < MULTI.pairs.length; i++) {
                var p = MULTI.pairs[i];
                var sn = p.srcLayer ? p.srcLayer.name.substring(0, 7) : "?src";
                var tn = p.tgtLayer ? p.tgtLayer.name.substring(0, 7) : "?tgt";
                var sc = p.srcPaths ? p.srcPaths.length : 0, tc = p.tgtPaths ? p.tgtPaths.length : 0;
                var mode = (!p.srcLayer || !p.tgtLayer) ? "--" : (sc === tc ? "1:1" : (sc < tc ? "SPLIT" : "MERGE"));
                multiList.add("item", "[" + i + "] " + sn + "\u2192" + tn + " [" + mode + "] @" + (p.startSec || 0).toFixed(1) + "s " + (p.duration || CFG.duration).toFixed(1) + "s");
            }
            var ready = 0; for (var i = 0; i < MULTI.pairs.length; i++) if (MULTI.pairs[i].srcLayer && MULTI.pairs[i].tgtLayer) ready++;
            if (!MULTI.pairs.length) { mStatusLbl.text = "No pairs yet."; pen(mStatusLbl, C.gray); }
            else { mStatusLbl.text = ready + "/" + MULTI.pairs.length + " pairs ready"; pen(mStatusLbl, ready === MULTI.pairs.length ? C.green : C.yellow); }
        }

        mAddBtn.onClick = function () {
            MULTI.pairs.push({ srcLayer: null, tgtLayer: null, srcPaths: [], tgtPaths: [], startSec: 0, duration: CFG.duration });
            refreshMulti(); multiList.selection = MULTI.pairs.length - 1;
            setStatus("Pair " + MULTI.pairs.length + " added. Set Src then Tgt.", C.blue);
        };

        mRemBtn.onClick = function () {
            var idx = multiList.selection ? multiList.selection.index : -1; if (idx < 0) return;
            MULTI.pairs.splice(idx, 1); refreshMulti(); setStatus("Pair removed.", C.gray);
        };

        mSrcBtn.onClick = function () {
            var idx = multiList.selection ? multiList.selection.index : -1;
            if (idx < 0) { setStatus("Select a pair row first.", C.red); return; }
            var l = getSelectedShapeLayer();
            if (!l) { setStatus("Select a Shape Layer in the timeline first.", C.red); return; }
            convertToBezier(l); l.label = LBL_GREEN;
            MULTI.pairs[idx].srcLayer = l; MULTI.pairs[idx].srcPaths = getAllPaths(l);
            refreshMulti(); setStatus("Pair " + (idx + 1) + " source: " + l.name, C.green);
        };

        mTgtBtn.onClick = function () {
            var idx = multiList.selection ? multiList.selection.index : -1;
            if (idx < 0) { setStatus("Select a pair row first.", C.red); return; }
            var l = getSelectedShapeLayer();
            if (!l) { setStatus("Select a Shape Layer in the timeline first.", C.red); return; }
            convertToBezier(l); l.label = LBL_ORANGE;
            MULTI.pairs[idx].tgtLayer = l; MULTI.pairs[idx].tgtPaths = getAllPaths(l);
            refreshMulti(); setStatus("Pair " + (idx + 1) + " target: " + l.name, C.orange);
        };

        mStartEdit.onChange = function () {
            var idx = multiList.selection ? multiList.selection.index : -1; if (idx < 0) return;
            var v = parseFloat(mStartEdit.text); if (!isNaN(v)) { MULTI.pairs[idx].startSec = v; refreshMulti(); }
        };

        mDurEdit.onChange = function () {
            var idx = multiList.selection ? multiList.selection.index : -1; if (idx < 0) return;
            var v = parseFloat(mDurEdit.text); if (!isNaN(v) && v > 0) { MULTI.pairs[idx].duration = v; refreshMulti(); }
        };

        multiList.onChange = function () {
            var idx = multiList.selection ? multiList.selection.index : -1;
            if (idx >= 0) {
                mStartEdit.text = (MULTI.pairs[idx].startSec || 0).toFixed(1);
                mDurEdit.text = (MULTI.pairs[idx].duration || CFG.duration).toFixed(1);
            }
        };

        // ══════════════════════════════════════════════════════════════════════
        //  CREATE MORPH  handler
        // ══════════════════════════════════════════════════════════════════════
        morphBtn.onClick = function () {
            setStatus("Working\u2026", C.yellow);
            try { win.update(); } catch(e) {} // safe in both Window and docked-Panel mode
            if (SESSION.mode === "single") {
                if (!SINGLE.srcLayer || !SINGLE.tgtLayer) { setStatus("Set \u2460 FROM and \u2461 TO first!", C.red); return; }
                var r = execSingle();
                if (r) setStatus("\u2713 Done! " + r, C.green); else setStatus("Error \u2014 see alert.", C.red);
            } else if (SESSION.mode === "chain") {
                if (CHAIN.steps.length < 2) { setStatus("Add 2+ steps first!", C.red); return; }
                var r = execChain();
                if (r) setStatus("\u2713 Chain done! " + r, C.green); else setStatus("Error \u2014 see alert.", C.red);
            } else {
                if (!MULTI.pairs.length) { setStatus("Add at least one pair first!", C.red); return; }
                var r = execMulti();
                if (r) setStatus("\u2713 Multi done! " + r.length + " layers", C.green); else setStatus("Error \u2014 see alert.", C.red);
            }
        };

        // ══════════════════════════════════════════════════════════════════════
        //  POST-MORPH TOOLS  handlers
        // ══════════════════════════════════════════════════════════════════════
        revBtn.onClick = function () {
            var l = (SESSION.mode === "single" && SINGLE.tgtLayer) ? SINGLE.tgtLayer : getSelectedShapeLayer();
            if (!l) { setStatus("Select a target layer in the timeline.", C.red); return; }
            var n = reverseTargetPaths(l);
            if (typeof n === "number") setStatus("Reversed " + n + " path(s) on " + l.name, C.teal);
            else setStatus(n, C.red);
        };

        nudgeBtn.onClick = function () {
            var l = (SESSION.mode === "single" && SINGLE.tgtLayer) ? SINGLE.tgtLayer : getSelectedShapeLayer();
            if (!l) { setStatus("Select a target layer in the timeline.", C.red); return; }
            var n = nudgeTargetPaths(l);
            if (typeof n === "number") setStatus("Nudged +1 vertex on " + n + " path(s)", C.teal);
            else setStatus(n, C.red);
        };

        bakeBtn.onClick = function () {
            var msg = bakeSelected();
            if (msg === "ok") setStatus("\u2713 Null baked \u2014 export ready!", C.green);
            else setStatus(msg, C.red);
        };

        // ══════════════════════════════════════════════════════════════════════
        //  INIT
        // ══════════════════════════════════════════════════════════════════════
        tp.selection = sTab;
        SESSION.mode = "single";
        setStatus("From \u2192 To \u2192 Create", C.gray);

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); }

        return win;
    }

    buildUI(thisObj);

})(this);
