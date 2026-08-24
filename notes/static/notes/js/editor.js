/* Notada canvas editor engine.
 *
 * One unified surface: type, draw, and drop code blocks on the same pages.
 * Objects (page-local coords):
 *   stroke: {type:"stroke", color, size, mode:"pen"|"highlighter", points:[[x,y]..]}
 *   text:   {type:"text", x, y, w, rotation, fontSize, color, bold, italic, family, text}
 *   image:  {type:"image", x, y, w, h, rotation, src}
 *   code:   {type:"code", x, y, w, rotation, fontSize, language, text}
 * Pages: {id, width, height, bgColor, ruled, background(pdf image|null), objects:[]}
 */
window.NotadaEditor = (function () {
  "use strict";

  const PAGE_GAP = 34, DEFAULT_W = 794, DEFAULT_H = 1123;
  let _seq = 0;
  const uid = () => "o" + (_seq++).toString(36) + Math.floor(performance.now()).toString(36);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function rot(x, y, a) { const c = Math.cos(a), s = Math.sin(a); return { x: x * c - y * s, y: x * s + y * c }; }

  // hljs class -> colour (a light theme that also reads well in exported PDFs)
  const CODE_COLORS = {
    keyword: "#a626a4", built_in: "#c18401", type: "#c18401", literal: "#0184bc",
    number: "#986801", string: "#50a14f", regexp: "#50a14f", meta: "#4078f2",
    comment: "#a0a1a7", title: "#4078f2", "title function_": "#4078f2", "title class_": "#c18401",
    function_: "#4078f2", class_: "#c18401", attr: "#986801", attribute: "#986801",
    params: "#383a42", variable: "#e45649", operator: "#383a42", punctuation: "#383a42",
    property: "#e45649", "selector-tag": "#e45649", symbol: "#4078f2", name: "#e45649",
  };
  const CODE_DEFAULT = "#383a42";
  function clsColor(cls) {
    if (!cls) return CODE_DEFAULT;
    const c = cls.replace(/hljs-/g, "").trim();
    if (CODE_COLORS[c]) return CODE_COLORS[c];
    const first = c.split(" ")[0];
    return CODE_COLORS[first] || CODE_DEFAULT;
  }

  // LaTeX -> SVG data URL (via MathJax), colour-substituted so it rasterises cleanly.
  function renderMathSvg(latex, color) {
    if (!window.MathJax || !window.MathJax.tex2svg) return null;
    try {
      const node = MathJax.tex2svg(latex || "", { display: true });
      const svg = node.querySelector("svg"); if (!svg) return null;
      const vb = (svg.getAttribute("viewBox") || "0 0 1000 500").split(" ").map(parseFloat);
      const em = 26, w = Math.max(8, vb[2] / 1000 * em), h = Math.max(8, vb[3] / 1000 * em);
      svg.setAttribute("width", w); svg.setAttribute("height", h);
      const xml = new XMLSerializer().serializeToString(svg).split("currentColor").join(color || "#1a1a1a");
      return { src: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml))), w, h };
    } catch (e) { return null; }
  }
  function drawMarker(c, x, y, shape, s, color) {
    c.save(); c.fillStyle = color; c.strokeStyle = color; c.lineWidth = 1.5; c.beginPath();
    if (shape === "square") c.rect(x - s, y - s, s * 2, s * 2);
    else if (shape === "triangle") { c.moveTo(x, y - s); c.lineTo(x + s, y + s); c.lineTo(x - s, y + s); c.closePath(); }
    else if (shape === "diamond") { c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); }
    else if (shape === "cross") { c.moveTo(x - s, y - s); c.lineTo(x + s, y + s); c.moveTo(x + s, y - s); c.lineTo(x - s, y + s); c.stroke(); c.restore(); return; }
    else c.arc(x, y, s, 0, Math.PI * 2);
    c.fill(); c.restore();
  }
  const MARKERS = ["circle", "square", "triangle", "diamond", "cross"];

  function rotateImageDataURL(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement("canvas"); c.width = img.height; c.height = img.width; const x = c.getContext("2d"); x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(img, 0, 0); resolve(c.toDataURL("image/jpeg", 0.85)); };
      img.onerror = () => resolve(src); img.src = src;
    });
  }

  function create(wrap, opts) {
    opts = opts || {};
    const canvas = wrap.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const imgCache = new Map();

    const ed = {
      doc: { pages: [], defaults: { pageColor: "#ffffff", ruled: false } },
      tool: "select",
      pen: { color: "#1a1a1a", size: 4 },
      highlighter: { color: "#ffd54a", size: 16 },
      textDefaults: { fontSize: 22, color: "#1a1a1a", bold: false, italic: false, family: "system-ui" },
      codeDefaults: { fontSize: 15, language: "python" },
      view: { scale: 1, panX: 0, panY: 0 },
      sel: null, spaceHeld: false,
      _pageTops: [], _hotspots: [], _pagebtns: [], _marquee: null,
      undoStack: [], redoStack: [], dirty: false,
    };

    // ---- undo ------------------------------------------------------------
    function snapshot() { ed.undoStack.push(clone(ed.doc)); if (ed.undoStack.length > 40) ed.undoStack.shift(); ed.redoStack.length = 0; if (opts.onHistory) opts.onHistory(canUndo(), canRedo()); }
    function canUndo() { return ed.undoStack.length > 0; }
    function canRedo() { return ed.redoStack.length > 0; }
    function undo() { if (!ed.undoStack.length) return; commitText(); ed.redoStack.push(clone(ed.doc)); ed.doc = ed.undoStack.pop(); afterRestore(); }
    function redo() { if (!ed.redoStack.length) return; commitText(); ed.undoStack.push(clone(ed.doc)); ed.doc = ed.redoStack.pop(); afterRestore(); }
    function afterRestore() {
      ed.sel = null; ed.dirty = true; ensureDefaults();
      fitKeep(); render();
      if (opts.onChange) opts.onChange(); if (opts.onSelect) opts.onSelect(0);
      if (opts.onPages) opts.onPages(ed.doc.pages.length, currentPageIndex() + 1);
      if (opts.onHistory) opts.onHistory(canUndo(), canRedo());
    }

    // ---- images ----------------------------------------------------------
    function getImage(src) { let r = imgCache.get(src); if (!r) { r = { img: new Image(), loaded: false }; r.img.onload = () => { r.loaded = true; render(); }; r.img.src = src; imgCache.set(src, r); } return r; }
    function preloadAll() {
      const srcs = []; ed.doc.pages.forEach((p) => { if (p.background) srcs.push(p.background); p.objects.forEach((o) => { if (o.type === "image") srcs.push(o.src); }); });
      return Promise.all(srcs.map((src) => new Promise((res) => { const r = getImage(src); if (r.loaded) return res(); r.img.addEventListener("load", () => res(), { once: true }); r.img.addEventListener("error", () => res(), { once: true }); })));
    }

    // ---- layout ----------------------------------------------------------
    function layout() { let y = PAGE_GAP; ed._pageTops = ed.doc.pages.map((p) => { const t = y; y += p.height + PAGE_GAP; return t; }); }
    function maxPageWidth() { return ed.doc.pages.reduce((m, p) => Math.max(m, p.width), DEFAULT_W); }
    const s2d = (sx, sy) => ({ x: (sx - ed.view.panX) / ed.view.scale, y: (sy - ed.view.panY) / ed.view.scale });
    const d2s = (dx, dy) => ({ x: dx * ed.view.scale + ed.view.panX, y: dy * ed.view.scale + ed.view.panY });
    const pageLeft = (p) => -p.width / 2;
    function l2s(i, lx, ly) { const p = ed.doc.pages[i]; return d2s(pageLeft(p) + lx, ed._pageTops[i] + ly); }
    function docToPageLocal(dx, dy) { for (let i = 0; i < ed.doc.pages.length; i++) { const p = ed.doc.pages[i], top = ed._pageTops[i]; if (dy >= top && dy <= top + p.height) return { index: i, lx: dx - pageLeft(p), ly: dy - top }; } return null; }
    function nearestPageIndex(dy) { let best = 0, bd = Infinity; ed.doc.pages.forEach((p, i) => { const mid = ed._pageTops[i] + p.height / 2, d = Math.abs(mid - dy); if (d < bd) { bd = d; best = i; } }); return best; }

    // ---- fonts -----------------------------------------------------------
    function textFont(o) { return `${o.italic ? "italic " : ""}${o.bold ? "700" : "400"} ${o.fontSize}px ${o.family || "system-ui"}, -apple-system, "Segoe UI", sans-serif`; }
    function codeFont(o) { return `${o.fontSize}px ui-monospace, "Cascadia Code", "Consolas", monospace`; }

    // ---- rendering -------------------------------------------------------
    let rafPending = false;
    function render() { if (rafPending) return; rafPending = true; requestAnimationFrame(doRender); }
    function doRender() {
      rafPending = false;
      const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      layout();
      const { scale, panX, panY } = ed.view;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, panX * dpr, panY * dpr);
      ed.doc.pages.forEach((p, i) => {
        const left = pageLeft(p), top = ed._pageTops[i];
        ctx.save(); ctx.translate(left, top);
        ctx.fillStyle = "rgba(0,0,0,.14)"; ctx.fillRect(3 / scale, 3 / scale, p.width, p.height);
        drawPageContents(ctx, p);
        ctx.lineWidth = 1 / scale; ctx.strokeStyle = "rgba(0,0,0,.12)"; ctx.strokeRect(0, 0, p.width, p.height);
        ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.font = `${12 / scale}px system-ui`; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
        ctx.fillText(`${i + 1} / ${ed.doc.pages.length}`, 2, -4 / scale);
        ctx.restore();
      });
      // objects being dragged draw ON TOP of every page (so they aren't hidden
      // behind a page they're being moved over)
      if (ed._moving) { const mi = ed._moving.pageIndex, mp = ed.doc.pages[mi]; if (mp) { ctx.save(); ctx.translate(pageLeft(mp), ed._pageTops[mi]); mp.objects.forEach((o) => { if (ed._moving.ids.has(o.id)) drawObject(ctx, o); }); ctx.restore(); } }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHotspots(ctx); drawSelection(ctx);
      if (ed._marquee) { const m = ed._marquee; ctx.fillStyle = "rgba(91,124,250,.15)"; ctx.strokeStyle = "#5b7cfa"; ctx.lineWidth = 1; ctx.fillRect(m.x, m.y, m.w, m.h); ctx.strokeRect(m.x, m.y, m.w, m.h); }
      if (editingEl && editingRef) { const o = ed.doc.pages[editingRef.pageIndex] && ed.doc.pages[editingRef.pageIndex].objects.find((x) => x.id === editingRef.id); if (o) positionOverlay(editingEl, editingRef.pageIndex, o); }
    }

    function drawPageContents(c, p) {
      c.fillStyle = p.bgColor || "#ffffff"; c.fillRect(0, 0, p.width, p.height);
      if (p.background) { const r = getImage(p.background); if (r.loaded) c.drawImage(r.img, 0, 0, p.width, p.height); }
      else if (p.ruled) drawRuled(c, p);
      // While a text/code box is being edited the textarea shows its content;
      // skip drawing it on the main canvas so it doesn't render twice ("shadow").
      p.objects.forEach((o) => { if (c === ctx && editingRef && o.id === editingRef.id && (o.type === "text" || o.type === "code")) return; if (c === ctx && ed._moving && ed._moving.ids.has(o.id)) return; drawObject(c, o); });
    }
    function drawRuled(c, p) {
      c.save(); c.strokeStyle = "rgba(70,110,200,.22)"; c.lineWidth = 1;
      for (let y = 60; y < p.height; y += 34) { c.beginPath(); c.moveTo(28, y); c.lineTo(p.width - 20, y); c.stroke(); }
      c.strokeStyle = "rgba(220,80,90,.28)"; c.beginPath(); c.moveTo(56, 20); c.lineTo(56, p.height - 20); c.stroke();
      c.restore();
    }

    function drawObject(c, o) {
      if (o.type === "stroke") {
        const pts = o.points; if (!pts.length) return;
        c.save();
        if (o.rotation) { const b = objBox(o), bx = b.x + b.w / 2, by = b.y + b.h / 2; c.translate(bx, by); c.rotate(o.rotation); c.translate(-bx, -by); }
        c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = o.color; c.lineWidth = o.size; c.globalAlpha = o.mode === "highlighter" ? 0.3 : 1;
        if (pts.length === 1) { c.fillStyle = o.color; c.beginPath(); c.arc(pts[0][0], pts[0][1], Math.max(0.5, o.size / 2), 0, Math.PI * 2); c.fill(); }
        else if (pts.length === 2) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); c.stroke(); }
        else { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); } c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); c.stroke(); }
        c.restore();
      } else if (o.type === "image") {
        const r = getImage(o.src); c.save(); c.translate(o.x + o.w / 2, o.y + o.h / 2); c.rotate(o.rotation || 0);
        const rad = Math.min(o.radius || 0, o.w / 2, o.h / 2); if (rad > 0) { roundRect(c, -o.w / 2, -o.h / 2, o.w, o.h, rad); c.clip(); }
        if (r.loaded) {
          const nw = r.img.naturalWidth || r.img.width, nh = r.img.naturalHeight || r.img.height, cr = o.crop || { x: 0, y: 0, w: 1, h: 1 };
          c.drawImage(r.img, cr.x * nw, cr.y * nh, cr.w * nw, cr.h * nh, -o.w / 2, -o.h / 2, o.w, o.h);
        } else { c.fillStyle = "#eee"; c.fillRect(-o.w / 2, -o.h / 2, o.w, o.h); } c.restore();
      } else if (o.type === "text" && o.html != null) {
        // rich text (HTML with mixed styles, links and lists)
        const th = textHeight(o), notEmpty = richPlain(o).trim().length > 0;
        c.save(); c.translate(o.x + o.w / 2, o.y + th / 2); c.rotate(o.rotation || 0); c.translate(-o.w / 2, -th / 2);
        if (!notEmpty) { if (c === ctx) { c.fillStyle = "rgba(120,130,150,.5)"; c.font = textFont(o); c.textBaseline = "top"; c.fillText("Text…", 2, 2); } o._links = []; }
        else { const lay = richLayout(c, o); drawRichLines(c, o, lay); o._links = lay.links; }
        c.restore();
      } else if (o.type === "text") {
        const empty = !(o.text || "").trim(), th = textHeight(o), lh = o.fontSize * (o.lineHeight || 1.3), al = o.align || "left";
        c.save(); c.translate(o.x + o.w / 2, o.y + th / 2); c.rotate(o.rotation || 0); c.translate(-o.w / 2, -th / 2);
        c.font = textFont(o); const lines = wrapText(c, o);
        const lineX = (ln) => { const w = c.measureText(ln).width; return al === "center" ? (o.w - w) / 2 : al === "right" ? (o.w - 4 - w) : 2; };
        if (o.highlight && !empty) { c.save(); c.fillStyle = o.highlight; c.globalAlpha = 0.4; lines.forEach((ln, i) => { if (ln) c.fillRect(lineX(ln) - 1, 2 + i * lh, c.measureText(ln).width + 3, lh); }); c.restore(); }
        c.textBaseline = "top"; c.textAlign = "left";
        if (empty && c === ctx) { c.fillStyle = "rgba(120,130,150,.5)"; c.fillText("Text…", 2, 2); }
        else {
          c.fillStyle = o.color; lines.forEach((ln, i) => c.fillText(ln, lineX(ln), 2 + i * lh));
          if ((o.strike || o.underline) && !empty) { c.strokeStyle = o.color; c.lineWidth = Math.max(1, o.fontSize / 16); lines.forEach((ln, i) => { if (!ln) return; const x0 = lineX(ln), w = c.measureText(ln).width; if (o.underline) { const y = 2 + i * lh + o.fontSize * 1.06; c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke(); } if (o.strike) { const y = 2 + i * lh + o.fontSize * 0.62; c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke(); } }); }
        }
        c.restore();
      } else if (o.type === "code") {
        const empty = !(o.text || "").trim(), lines = layoutCode(c, o), lh = o.fontSize * 1.45, th = lines.length * lh + 20;
        c.save(); c.translate(o.x + o.w / 2, o.y + th / 2); c.rotate(o.rotation || 0); c.translate(-o.w / 2, -th / 2);
        c.fillStyle = "#f6f8fa"; roundRect(c, 0, 0, o.w, th, 8); c.fill();
        c.strokeStyle = "#e2e6ea"; c.lineWidth = 1; roundRect(c, 0, 0, o.w, th, 8); c.stroke();
        c.font = codeFont(o); c.textBaseline = "top"; c.textAlign = "left";
        if (empty && c === ctx) { c.fillStyle = "rgba(120,130,150,.7)"; c.fillText("‹ code — double-click to edit ›", 10, 10); }
        else lines.forEach((line, i) => line.forEach((seg) => { c.fillStyle = seg.color; c.fillText(seg.t, 10 + seg.x, 10 + i * lh); }));
        c.restore();
      } else if (o.type === "table") {
        drawTable(c, o);
      } else if (o.type === "chart") {
        drawChart(c, o);
      } else if (o.type === "math") {
        const w = o.w || 160, h = o.h || 40;
        c.save(); c.translate(o.x + w / 2, o.y + h / 2); c.rotate(o.rotation || 0); c.translate(-w / 2, -h / 2);
        if (o.src) { const r = getImage(o.src); if (r.loaded) c.drawImage(r.img, 0, 0, w, h); }
        else if (c === ctx) { c.fillStyle = "rgba(120,130,150,.6)"; c.font = "14px system-ui"; c.textBaseline = "top"; c.fillText("∑ math — double-click to edit", 2, 2); }
        c.restore();
      } else if (o.type === "media") {
        const w = o.w || 240, h = o.h || 120;
        c.save(); c.translate(o.x + w / 2, o.y + h / 2); c.rotate(o.rotation || 0); c.translate(-w / 2, -h / 2);
        c.fillStyle = o.mediaType === "video" ? "#1c2436" : "#2a2440"; roundRect(c, 0, 0, w, h, Math.min(o.radius != null ? o.radius : 10, w / 2, h / 2)); c.fill();
        const cx = w / 2, cy = h / 2 - 6, s = Math.min(w, h) * 0.16;
        c.fillStyle = "rgba(255,255,255,.16)"; c.beginPath(); c.arc(cx, cy, s * 1.7, 0, Math.PI * 2); c.fill();
        c.fillStyle = "rgba(255,255,255,.95)"; c.beginPath(); c.moveTo(cx - s * 0.5, cy - s); c.lineTo(cx - s * 0.5, cy + s); c.lineTo(cx + s, cy); c.closePath(); c.fill();
        c.fillStyle = "rgba(255,255,255,.85)"; c.font = "12px system-ui"; c.textAlign = "center"; c.textBaseline = "bottom";
        c.fillText((o.mediaType === "video" ? "🎬 " : "🎵 ") + (o.name || o.mediaType), w / 2, h - 8);
        c.restore();
      } else if (o.type === "shape") {
        const w = o.w, h = o.h, sw = o.strokeWidth || 0, ins = sw / 2;
        c.save(); c.translate(o.x + w / 2, o.y + h / 2); c.rotate(o.rotation || 0); c.translate(-w / 2, -h / 2);
        c.lineJoin = "round"; c.lineCap = "round";
        c.beginPath();
        if (o.shape === "rect") { const r = Math.min(o.radius || 0, w / 2, h / 2); if (r > 0) roundRect(c, ins, ins, Math.max(0, w - sw), Math.max(0, h - sw), r); else c.rect(ins, ins, Math.max(0, w - sw), Math.max(0, h - sw)); }
        else if (o.shape === "ellipse") { c.ellipse(w / 2, h / 2, Math.max(0.5, w / 2 - ins), Math.max(0.5, h / 2 - ins), 0, 0, Math.PI * 2); }
        else if (o.shape === "triangle") { roundedPolygon(c, [[w / 2, ins], [w - ins, h - ins], [ins, h - ins]], o.radius || 0); }
        else if (o.shape === "diamond") { roundedPolygon(c, [[w / 2, ins], [w - ins, h / 2], [w / 2, h - ins], [ins, h / 2]], o.radius || 0); }
        else if (o.shape === "line") { if ((o.lineDir || 1) >= 0) { c.moveTo(ins, ins); c.lineTo(w - ins, h - ins); } else { c.moveTo(ins, h - ins); c.lineTo(w - ins, ins); } }
        if (o.fill && o.shape !== "line") { c.fillStyle = o.fill; c.fill(); }
        if (sw > 0 && o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = sw; c.stroke(); }
        c.restore();
      } else if (o.type === "sticky") {
        const s = 28; c.save(); c.translate(o.x, o.y);
        c.fillStyle = "rgba(0,0,0,.14)"; roundRect(c, 2, 2, s, s, 5); c.fill();
        c.fillStyle = o.color || "#ffe08a"; roundRect(c, 0, 0, s, s, 5); c.fill();
        c.strokeStyle = "rgba(0,0,0,.2)"; c.lineWidth = 1; roundRect(c, 0, 0, s, s, 5); c.stroke();
        c.strokeStyle = "rgba(0,0,0,.5)"; c.lineWidth = 1.6; for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(7, 10 + i * 5); c.lineTo(21, 10 + i * 5); c.stroke(); }
        c.restore();
      }
    }
    function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
    // Draw a closed polygon whose corners are rounded by radius r (clamped to fit the shortest edge).
    function roundedPolygon(c, pts, r) {
      const n = pts.length;
      if (!r || r <= 0) { c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); return; }
      let minEdge = Infinity; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; minEdge = Math.min(minEdge, Math.hypot(b[0] - a[0], b[1] - a[1])); }
      r = Math.min(r, minEdge / 2);
      const mid = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
      c.moveTo(mid[0], mid[1]);
      for (let i = 0; i < n; i++) { const cur = pts[i], nxt = pts[(i + 1) % n]; c.arcTo(cur[0], cur[1], nxt[0], nxt[1], r); }
      c.closePath();
    }

    // ---- tables (per-column widths + per-row heights) --------------------
    function tableCols(o) { if (!o.colW || o.colW.length !== o.cols) { const w = (o.w || 400) / o.cols; o.colW = Array.from({ length: o.cols }, () => w); } return o.colW; }
    function tableRows(o) { const dh = (o.fontSize || 14) * 2; if (!o.rowH || o.rowH.length !== o.rows) { o.rowH = Array.from({ length: o.rows }, () => dh); } return o.rowH; }
    function tableHeight(o) { return tableRows(o).reduce((a, b) => a + b, 0); }
    function tableWidth(o) { return tableCols(o).reduce((a, b) => a + b, 0); }
    function colX(o) { const cw = tableCols(o), xs = [0]; for (let i = 0; i < cw.length; i++) xs.push(xs[i] + cw[i]); return xs; }
    function rowY(o) { const rh = tableRows(o), ys = [0]; for (let i = 0; i < rh.length; i++) ys.push(ys[i] + rh[i]); return ys; }
    function drawTable(c, o) {
      const cw = tableCols(o), rh = tableRows(o), xs = colX(o), ys = rowY(o), W = xs[xs.length - 1], H = ys[ys.length - 1];
      o.w = W;
      c.save(); c.translate(o.x + W / 2, o.y + H / 2); c.rotate(o.rotation || 0); c.translate(-W / 2, -H / 2);
      for (let r = 0; r < o.rows; r++) { let fill = null; if (r === 0 && o.headerRow) fill = o.headerFill || "#eef1ff"; else if (o.altFill && ((r - (o.headerRow ? 1 : 0)) % 2 === 1)) fill = o.altFill; if (fill) { c.fillStyle = fill; c.fillRect(0, ys[r], W, rh[r]); } }
      c.strokeStyle = o.gridColor || "#c9cede"; c.lineWidth = 1;
      ys.forEach((y) => { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); });
      xs.forEach((x) => { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); });
      c.fillStyle = o.textColor || "#1a1a1a"; c.textBaseline = "middle";
      for (let r = 0; r < o.rows; r++) for (let col = 0; col < o.cols; col++) {
        const val = (o.data[r] && o.data[r][col] != null) ? String(o.data[r][col]) : "";
        const bold = (r === 0 && o.headerRow), al = o.align || "left";
        c.font = `${bold ? "700 " : ""}${o.fontSize || 14}px system-ui, -apple-system, sans-serif`;
        c.textAlign = al === "center" ? "center" : al === "right" ? "right" : "left";
        const tx = al === "center" ? xs[col] + cw[col] / 2 : al === "right" ? xs[col + 1] - 6 : xs[col] + 6;
        c.save(); c.beginPath(); c.rect(xs[col], ys[r], cw[col], rh[r]); c.clip();
        c.fillText(val, tx, ys[r] + rh[r] / 2); c.restore();
      }
      c.restore();
    }

    // ---- charts ----------------------------------------------------------
    function drawChart(c, o) {
      const w = o.w, h = o.h;
      c.save(); c.translate(o.x + w / 2, o.y + h / 2); c.rotate(o.rotation || 0); c.translate(-w / 2, -h / 2);
      c.fillStyle = "#ffffff"; roundRect(c, 0, 0, w, h, 8); c.fill(); c.strokeStyle = "#e2e6ea"; c.lineWidth = 1; roundRect(c, 0, 0, w, h, 8); c.stroke();
      let top = 12; c.fillStyle = "#1a1a1a"; c.textAlign = "center"; c.textBaseline = "top";
      if (o.title) { c.font = "700 14px system-ui"; c.fillText(o.title, w / 2, 8); top = 30; }
      const padL = 34, padR = 12, padB = 26, axisColor = o.axisColor || "#b9bfd0";
      if (o.chartType === "line") {
        const cats = o.categories || [], series = o.series || [], legendH = series.length > 1 ? 16 : 0;
        const plotW = w - padL - padR, plotH = h - top - padB - legendH;
        let maxV = 1; series.forEach((s) => (s.values || []).forEach((v) => { maxV = Math.max(maxV, Math.abs(v) || 0); }));
        c.strokeStyle = axisColor; c.beginPath(); c.moveTo(padL, top); c.lineTo(padL, top + plotH); c.lineTo(w - padR, top + plotH); c.stroke();
        c.fillStyle = "#7a8194"; c.font = "10px system-ui"; c.textAlign = "right"; c.textBaseline = "middle"; c.fillText(String(Math.round(maxV)), padL - 4, top); c.fillText("0", padL - 4, top + plotH);
        const n = cats.length || Math.max(1, ...series.map((s) => (s.values || []).length)), xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        series.forEach((s, si) => { const color = s.color || palAt(si), shape = MARKERS[si % MARKERS.length], vals = s.values || []; c.strokeStyle = color; c.lineWidth = 2; c.beginPath(); vals.forEach((v, i) => { const x = xAt(i), y = top + plotH - (Math.abs(v) || 0) / maxV * plotH; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); vals.forEach((v, i) => drawMarker(c, xAt(i), top + plotH - (Math.abs(v) || 0) / maxV * plotH, shape, 3.4, color)); });
        c.fillStyle = "#5a6072"; c.font = "10px system-ui"; c.textAlign = "center"; c.textBaseline = "top"; cats.forEach((lab, i) => c.fillText(String(lab || ""), xAt(i), top + plotH + 4));
        if (series.length > 1) { let lx = padL; const ly = h - 12; c.textAlign = "left"; c.textBaseline = "middle"; c.font = "10px system-ui"; series.forEach((s, si) => { const color = s.color || palAt(si), name = s.name || ("Series " + (si + 1)); drawMarker(c, lx + 5, ly, MARKERS[si % MARKERS.length], 3.4, color); c.fillStyle = "#5a6072"; c.fillText(name, lx + 14, ly); lx += 16 + c.measureText(name).width + 14; }); }
      } else {
        const pts = o.points || [], plotW = w - padL - padR, plotH = h - top - padB, maxV = Math.max(1, ...pts.map((p) => Math.abs(p.value) || 0));
        if (o.chartType === "pie") {
          const total = pts.reduce((s, p) => s + (Math.abs(p.value) || 0), 0) || 1, cx = (w - 70) / 2, cy = top + plotH / 2, R = Math.min(plotW - 70, plotH) / 2 - 4; let ang = -Math.PI / 2;
          pts.forEach((p, i) => { const a = (Math.abs(p.value) || 0) / total * Math.PI * 2; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, ang, ang + a); c.closePath(); c.fillStyle = p.color || palAt(i); c.fill(); ang += a; });
          c.textAlign = "left"; c.textBaseline = "middle"; c.font = "10px system-ui"; pts.forEach((p, i) => { const ly = top + i * 14 + 4; c.fillStyle = p.color || palAt(i); c.fillRect(w - 78, ly, 9, 9); c.fillStyle = "#5a6072"; c.fillText(String(p.label || ""), w - 65, ly + 4); });
        } else {
          c.strokeStyle = axisColor; c.beginPath(); c.moveTo(padL, top); c.lineTo(padL, top + plotH); c.lineTo(w - padR, top + plotH); c.stroke();
          c.fillStyle = "#7a8194"; c.font = "10px system-ui"; c.textAlign = "right"; c.textBaseline = "middle"; c.fillText(String(Math.round(maxV)), padL - 4, top); c.fillText("0", padL - 4, top + plotH);
          const bw = plotW / Math.max(1, pts.length), frac = o.barWidth || 0.66;
          pts.forEach((p, i) => { const bh = (Math.abs(p.value) || 0) / maxV * plotH, bx = padL + i * bw + bw * (1 - frac) / 2, by = top + plotH - bh; c.fillStyle = p.color || palAt(i); c.fillRect(bx, by, bw * frac, bh); });
          c.fillStyle = "#5a6072"; c.font = "10px system-ui"; c.textAlign = "center"; c.textBaseline = "top"; pts.forEach((p, i) => c.fillText(String(p.label || ""), padL + i * bw + bw / 2, top + plotH + 4));
        }
      }
      c.restore();
    }
    const CHART_PAL = ["#5b7cfa", "#e4576b", "#2ca24c", "#f5a623", "#9b51e0", "#00b4c6", "#ff7a45"];
    function palAt(i) { return CHART_PAL[i % CHART_PAL.length]; }

    function wrapText(c, o) {
      c.font = textFont(o); const out = [];
      (o.text || "").split("\n").forEach((para) => {
        if (para === "") { out.push(""); return; }
        let line = ""; para.split(/(\s+)/).forEach((word) => { const t = line + word; if (c.measureText(t).width > o.w - 4 && line) { out.push(line); line = word.replace(/^\s+/, ""); } else line = t; }); out.push(line);
      }); return out;
    }
    function textHeight(o) { if (o.html != null) return richLayout(ctx, o).height; const lh = o.fontSize * (o.lineHeight || 1.3); return Math.max(lh, wrapText(ctx, o).length * lh) + 4; }

    // ---- rich text ------------------------------------------------------
    const _rt = document.createElement("div");
    function richPlain(o) { _rt.innerHTML = o.html || ""; return _rt.textContent || ""; }
    // Strip anything executable from stored/imported HTML (DOMParser is inert — it
    // does not run scripts or load images), so a malicious note can't run code.
    function sanitizeRich(html) {
      const doc = new DOMParser().parseFromString(html || "", "text/html");
      doc.querySelectorAll("script,iframe,object,embed,link,meta,style,base,form,input,button").forEach((n) => n.remove());
      doc.querySelectorAll("*").forEach((el) => { [...el.attributes].forEach((a) => { const n = a.name.toLowerCase(); if (n.startsWith("on")) el.removeAttribute(a.name); else if ((n === "href" || n === "src") && /^\s*(javascript|data|vbscript):/i.test(a.value)) el.removeAttribute(a.name); }); });
      return doc.body.innerHTML;
    }
    function parseRich(o) {
      const root = document.createElement("div"); root.innerHTML = o.html || "";
      const base = { b: !!o.bold, i: !!o.italic, u: !!o.underline, s: !!o.strike, color: o.color || "#1a1a1a", size: o.fontSize || 20, fam: o.family || "system-ui", href: null };
      const blocks = []; let cur = null, olCount = 0;
      const newBlock = (kind, num) => { cur = { kind: kind || "para", num: num || 0, runs: [] }; blocks.push(cur); };
      const addText = (t, st) => { if (t == null) return; t = t.replace(/ /g, " "); if (t === "") return; if (!cur) newBlock("para"); cur.runs.push({ text: t, b: st.b, i: st.i, u: st.u, s: st.s, color: st.color, size: st.size, fam: st.fam, href: st.href, hl: st.hl, btn: st.btn, btnBg: st.btnBg }); };
      const styleFor = (el, st) => { const s = { ...st }, tag = el.tagName.toLowerCase(); if (tag === "b" || tag === "strong") s.b = true; if (tag === "i" || tag === "em") s.i = true; if (tag === "u") s.u = true; if (tag === "s" || tag === "strike" || tag === "del") s.s = true; if (tag === "a") { s.href = el.getAttribute("href") || ""; if (el.dataset && el.dataset.btn) { s.btn = true; s.u = false; s.color = el.style.color || "#ffffff"; s.btnBg = el.style.backgroundColor || "#2a6df4"; } else { s.color = "#2a6df4"; s.u = true; } } const cs = el.style; if (cs) { if (cs.color) s.color = cs.color; if (cs.fontWeight === "700" || cs.fontWeight === "bold") s.b = true; if (cs.fontStyle === "italic") s.i = true; if (cs.fontFamily) s.fam = cs.fontFamily.replace(/["']/g, ""); const fz = parseFloat(cs.fontSize); if (fz) s.size = fz; const d = cs.textDecorationLine || cs.textDecoration || ""; if (d.includes("underline")) s.u = true; if (d.includes("line-through")) s.s = true; if (cs.backgroundColor && !s.btn) s.hl = cs.backgroundColor; } return s; };
      const walk = (node, st) => { node.childNodes.forEach((n) => {
        if (n.nodeType === 3) addText(n.nodeValue, st);
        else if (n.nodeType === 1) { const tag = n.tagName.toLowerCase();
          if (tag === "br") { newBlock("para"); return; }
          if (tag === "ol") { olCount = 0; walk(n, st); return; }
          if (tag === "ul") { walk(n, st); return; }
          if (tag === "li") { const pt = (n.parentElement && n.parentElement.tagName.toLowerCase()) === "ol"; if (pt) { olCount++; newBlock("number", olCount); } else newBlock("bullet"); walk(n, styleFor(n, st)); return; }
          if (tag === "div" || tag === "p") { newBlock("para"); walk(n, styleFor(n, st)); return; }
          walk(n, styleFor(n, st));
        } }); };
      walk(root, base);
      while (blocks.length > 1 && !blocks[blocks.length - 1].runs.length) blocks.pop();
      if (!blocks.length) newBlock("para");
      return { blocks, base };
    }
    const richFont = (r) => `${r.i ? "italic " : ""}${r.b ? "700" : "400"} ${r.size}px ${r.fam || "system-ui"}, -apple-system, sans-serif`;
    function richLayout(c, o) {
      const { blocks, base } = parseRich(o), maxW = o.w - 4, lines = [], links = [], al = o.align || "left", lhMul = o.lineHeight || 1.3;
      blocks.forEach((blk) => {
        const indent = (blk.kind === "bullet" || blk.kind === "number") ? 22 : 0;
        let segs = [], x = indent, first = true;
        const flush = () => { lines.push({ segs, indent, marker: first ? (blk.kind === "bullet" ? "•" : blk.kind === "number" ? (blk.num + ".") : "") : "", markerRun: blk.runs[0] || null, base }); segs = []; x = indent; first = false; };
        if (!blk.runs.length) { flush(); return; }
        blk.runs.forEach((r) => { c.font = richFont(r); r.text.split(/(\s+)/).forEach((word) => { if (word === "") return; const w = c.measureText(word).width; if (x + w > maxW && segs.length) flush(); segs.push({ text: word, r, x, w }); x += w; }); });
        flush();
      });
      let y = 2;
      lines.forEach((ln) => {
        const sizes = ln.segs.length ? ln.segs.map((s) => s.r.size) : [base.size], lineH = Math.max(...sizes) * lhMul;
        const lineW = ln.segs.length ? (ln.segs[ln.segs.length - 1].x + ln.segs[ln.segs.length - 1].w) : ln.indent;
        let ax = 0; if (al === "center") ax = (o.w - lineW) / 2; else if (al === "right") ax = (o.w - 4 - lineW);
        ln.y = y; ln.lh = lineH; ln.ax = ax;
        ln.segs.forEach((s) => { if (s.r.href) links.push({ x: ax + s.x, y, w: s.w, h: lineH, href: s.r.href }); });
        y += lineH;
      });
      return { lines, links, height: y + 2, base };
    }
    function drawRichLines(c, o, lay) {
      c.textBaseline = "top"; c.textAlign = "left";
      lay.lines.forEach((ln) => {
        ln.segs.forEach((s) => { const r = s.r; if (r.btn) { c.save(); c.fillStyle = r.btnBg || "#2a6df4"; c.fillRect(ln.ax + s.x - 3, ln.y + 1, s.w + 6, ln.lh - 2); c.restore(); } else if (r.hl) { c.save(); c.fillStyle = r.hl; c.globalAlpha = 0.5; c.fillRect(ln.ax + s.x - 1, ln.y, s.w + 2, ln.lh); c.restore(); } });
        if (ln.marker) {
          // Markers inherit the style of the text they label; markerScale / markerColor let them differ slightly.
          const mr = ln.markerRun || { size: ln.base.size, color: o.color || "#1a1a1a", fam: "system-ui", b: false, i: false };
          const sc = o.markerScale || 1, msize = Math.max(4, mr.size * sc);
          c.font = `${mr.i ? "italic " : ""}${mr.b ? "700" : "400"} ${msize}px ${mr.fam || "system-ui"}, -apple-system, sans-serif`;
          c.fillStyle = o.markerColor || mr.color || "#1a1a1a";
          c.textAlign = "right"; c.fillText(ln.marker, ln.ax + ln.indent - 6, ln.y + (mr.size - msize) + 1); c.textAlign = "left";
        }
        ln.segs.forEach((s) => { const r = s.r; c.font = richFont(r); c.fillStyle = r.color; c.fillText(s.text, ln.ax + s.x, ln.y);
          if (r.u || r.s) { c.strokeStyle = r.color; c.lineWidth = Math.max(1, r.size / 16); if (r.u) { const yy = ln.y + r.size * 1.02; c.beginPath(); c.moveTo(ln.ax + s.x, yy); c.lineTo(ln.ax + s.x + s.w, yy); c.stroke(); } if (r.s) { const yy = ln.y + r.size * 0.62; c.beginPath(); c.moveTo(ln.ax + s.x, yy); c.lineTo(ln.ax + s.x + s.w, yy); c.stroke(); } }
        });
      });
    }
    function linkAtLocal(o, lx, ly) { if (!o._links) return null; for (const L of o._links) if (lx >= L.x && lx <= L.x + L.w && ly >= L.y && ly <= L.y + L.h) return L.href; return null; }

    function codeRuns(text, lang) {
      let html;
      try { html = (window.hljs && lang) ? hljs.highlight(text || "", { language: lang, ignoreIllegal: true }).value : escapeHtml(text || ""); }
      catch (e) { html = escapeHtml(text || ""); }
      const div = document.createElement("div"); div.innerHTML = html; const runs = [];
      (function walk(node, cls) { node.childNodes.forEach((ch) => { if (ch.nodeType === 3) runs.push({ text: ch.nodeValue, cls }); else if (ch.nodeType === 1) walk(ch, (ch.className || cls || "")); }); })(div, "");
      return runs;
    }
    function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
    function layoutCode(c, o) {
      c.font = codeFont(o); const maxW = o.w - 20, lines = []; let cur = [], x = 0;
      const push = (t, color) => { const w = c.measureText(t).width; if (x + w > maxW && cur.length) { lines.push(cur); cur = []; x = 0; } cur.push({ t, color, x }); x += w; };
      codeRuns(o.text, o.language).forEach((r) => {
        const color = clsColor(r.cls);
        r.text.split(/(\n)/).forEach((part) => { if (part === "\n") { lines.push(cur); cur = []; x = 0; } else part.split(/(\s+)/).forEach((wd) => { if (wd) push(wd, color); }); });
      });
      lines.push(cur); return lines;
    }
    function codeHeight(o) { return layoutCode(ctx, o).length * o.fontSize * 1.45 + 20; }

    function objBox(o) {
      if (o.type === "text") return { x: o.x, y: o.y, w: o.w, h: textHeight(o) };
      if (o.type === "code") return { x: o.x, y: o.y, w: o.w, h: codeHeight(o) };
      if (o.type === "sticky") return { x: o.x, y: o.y, w: 28, h: 28 };
      if (o.type === "table") return { x: o.x, y: o.y, w: tableWidth(o), h: tableHeight(o) };
      if (o.type === "math") return { x: o.x, y: o.y, w: o.w || 160, h: o.h || 40 };
      if (o.type === "chart" || o.type === "image" || o.type === "media" || o.type === "shape") return { x: o.x, y: o.y, w: o.w, h: o.h };
      let a = Infinity, b = Infinity, e = -Infinity, f = -Infinity; o.points.forEach(([x, y]) => { a = Math.min(a, x); b = Math.min(b, y); e = Math.max(e, x); f = Math.max(f, y); }); const pad = (o.size || 2) / 2;
      return { x: a - pad, y: b - pad, w: (e - a) + 2 * pad, h: (f - b) + 2 * pad };
    }
    function objAABB(o) { const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cs = [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2]].map(([dx, dy]) => { const p = rot(dx, dy, r); return [cx + p.x, cy + p.y]; }); const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]); return { x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }; }

    function selObjects() { if (!ed.sel) return []; const objs = ed.doc.pages[ed.sel.pageIndex].objects; return ed.sel.ids.map((id) => objs.find((x) => x.id === id)).filter(Boolean); }
    function drawSelection(c) {
      if (!ed.sel) return; const pi = ed.sel.pageIndex, objs = selObjects();
      c.save(); c.strokeStyle = "#5b7cfa"; c.lineWidth = 1.5;
      objs.forEach((o) => { const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(pi, cx + p.x, cy + p.y); }; const tl = cn(-b.w / 2, -b.h / 2), tr = cn(b.w / 2, -b.h / 2), br = cn(b.w / 2, b.h / 2), bl = cn(-b.w / 2, b.h / 2); c.beginPath(); c.moveTo(tl.x, tl.y); c.lineTo(tr.x, tr.y); c.lineTo(br.x, br.y); c.lineTo(bl.x, bl.y); c.closePath(); c.stroke(); });
      if (objs.length === 1) {
        const o = objs[0], b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0;
        const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(pi, cx + p.x, cy + p.y); };
        const tm = cn(0, -b.h / 2), rh = cn(0, -b.h / 2 - 26 / ed.view.scale);
        c.beginPath(); c.moveTo(tm.x, tm.y); c.lineTo(rh.x, rh.y); c.stroke(); dot(c, rh, "#5b7cfa");
        if (o.type === "image" || o.type === "chart" || o.type === "media" || o.type === "shape") { [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => dot(c, cn(dx * b.w / 2, dy * b.h / 2), "#fff", "#5b7cfa")); }
        else dot(c, cn(b.w / 2, b.h / 2), "#fff", "#5b7cfa");
      } else {
        // group bounding box + a proportional-scale handle at its corner
        const g = groupBBox();
        if (g) { const tl = l2s(pi, g.x, g.y), br = l2s(pi, g.x + g.w, g.y + g.h); c.save(); c.setLineDash([4, 3]); c.strokeStyle = "rgba(91,124,250,.7)"; c.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); c.restore(); dot(c, br, "#fff", "#5b7cfa"); }
      }
      c.restore();
    }
    function dot(c, p, fill, stroke) { c.beginPath(); c.arc(p.x, p.y, 7, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); c.lineWidth = 2; c.strokeStyle = stroke || fill; c.stroke(); }

    function drawHotspots(c) {
      ed._hotspots = []; ed._pagebtns = [];
      const cxScreen = d2s(0, 0).x;
      const addPlus = (index, docY) => { const s = d2s(0, docY); ed._hotspots.push({ index, cx: cxScreen, cy: s.y, r: 13 }); c.save(); c.beginPath(); c.arc(cxScreen, s.y, 13, 0, Math.PI * 2); c.fillStyle = "#5b7cfa"; c.globalAlpha = .9; c.fill(); c.globalAlpha = 1; c.fillStyle = "#fff"; c.font = "bold 18px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("+", cxScreen, s.y); c.restore(); };
      addPlus(0, PAGE_GAP / 2);
      ed.doc.pages.forEach((p, i) => {
        addPlus(i + 1, ed._pageTops[i] + p.height + PAGE_GAP / 2);
        // per-page "⋯" button at top-right of the page
        const tr = l2s(i, p.width, 0); const bx = tr.x - 16, by = tr.y + 16;
        ed._pagebtns.push({ index: i, cx: bx, cy: by, r: 14 });
        c.save(); c.beginPath(); c.arc(bx, by, 14, 0, Math.PI * 2); c.fillStyle = "#ffffff"; c.fill(); c.strokeStyle = "#c9cede"; c.lineWidth = 1; c.stroke();
        c.fillStyle = "#5b7cfa"; c.font = "bold 16px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("⋯", bx, by - 1); c.restore();
      });
    }

    // ---- viewport --------------------------------------------------------
    function fitWidth() { const w = wrap.clientWidth; ed.view.scale = Math.min(2, (w - 60) / maxPageWidth()); ed.view.panX = w / 2; ed.view.panY = 20; updateZoom(); render(); }
    function fitKeep() { const w = wrap.clientWidth; if (Math.abs(ed.view.panX) < 1 && Math.abs(ed.view.panY) < 1) { fitWidth(); } }
    function zoomAt(sx, sy, f) { ed._needFit = false; const b = s2d(sx, sy); ed.view.scale = Math.min(6, Math.max(0.15, ed.view.scale * f)); ed.view.panX = sx - b.x * ed.view.scale; ed.view.panY = sy - b.y * ed.view.scale; updateZoom(); render(); }
    function updateZoom() { if (opts.onZoom) opts.onZoom(Math.round(ed.view.scale * 100)); }
    function currentPageIndex() { return nearestPageIndex(s2d(wrap.clientWidth / 2, wrap.clientHeight / 2).y); }

    function changed() { ed.dirty = true; render(); if (opts.onChange) opts.onChange(); if (opts.onPages) opts.onPages(ed.doc.pages.length, currentPageIndex() + 1); }
    function setSelection(pi, ids) { ed.sel = ids && ids.length ? { pageIndex: pi, ids: [...new Set(ids)] } : null; if (opts.onSelect) opts.onSelect(ed.sel ? ed.sel.ids.length : 0); render(); }

    // ---- hit testing -----------------------------------------------------
    function pointInObject(o, lx, ly) {
      const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (o.type === "stroke") { let px = lx, py = ly; if (o.rotation) { const r = rot(lx - cx, ly - cy, -(o.rotation || 0)); px = cx + r.x; py = cy + r.y; } const tol = Math.max(6, o.size); for (let i = 0; i < o.points.length - 1; i++) if (distToSeg(px, py, o.points[i], o.points[i + 1]) <= tol) return true; if (o.points.length === 1) return Math.hypot(px - o.points[0][0], py - o.points[0][1]) <= tol; return false; }
      const p = rot(lx - cx, ly - cy, -(o.rotation || 0)); return Math.abs(p.x) <= b.w / 2 + 2 && Math.abs(p.y) <= b.h / 2 + 2;
    }
    function distToSeg(px, py, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1; let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)); }
    function topObjectAt(pi, lx, ly) { const objs = ed.doc.pages[pi].objects; for (let i = objs.length - 1; i >= 0; i--) if (pointInObject(objs[i], lx, ly)) return objs[i]; return null; }
    function groupBBox() { const objs = selObjects(); if (!objs.length) return null; let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; objs.forEach((o) => { const bb = objAABB(o); x1 = Math.min(x1, bb.x); y1 = Math.min(y1, bb.y); x2 = Math.max(x2, bb.x2); y2 = Math.max(y2, bb.y2); }); return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; }
    function handleAt(sx, sy) {
      if (!ed.sel) return null;
      if (ed.sel.ids.length > 1) { const g = groupBBox(); if (g) { const br = l2s(ed.sel.pageIndex, g.x + g.w, g.y + g.h); if (Math.hypot(sx - br.x, sy - br.y) <= 12) return "group-resize"; } return null; }
      if (ed.sel.ids.length !== 1) return null; const o = selObjects()[0]; if (!o) return null;
      const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0;
      const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(ed.sel.pageIndex, cx + p.x, cy + p.y); };
      const rh = cn(0, -b.h / 2 - 26 / ed.view.scale);
      if (Math.hypot(sx - rh.x, sy - rh.y) <= 12) return "rotate";
      if (o.type === "image" || o.type === "chart" || o.type === "media" || o.type === "shape") {
        const H = { "h-tl": [-1, -1], "h-tr": [1, -1], "h-bl": [-1, 1], "h-br": [1, 1], "h-t": [0, -1], "h-b": [0, 1], "h-l": [-1, 0], "h-r": [1, 0] };
        for (const k in H) { const pt = cn(H[k][0] * b.w / 2, H[k][1] * b.h / 2); if (Math.hypot(sx - pt.x, sy - pt.y) <= 11) return k; }
        return null;
      }
      const br = cn(b.w / 2, b.h / 2);
      if (Math.hypot(sx - br.x, sy - br.y) <= 12) return "resize";
      return null;
    }
    // detect a drag on an internal column/row border of the selected table
    function tableBorderAt(pos) {
      if (!ed.sel || ed.sel.ids.length !== 1) return null;
      const o = selObjects()[0]; if (!o || o.type !== "table" || Math.abs(o.rotation || 0) > 0.01) return null;
      const pi = ed.sel.pageIndex, p = ed.doc.pages[pi], d = s2d(pos.x, pos.y);
      const lx = d.x - pageLeft(p) - o.x, ly = d.y - ed._pageTops[pi] - o.y;
      const xs = colX(o), ys = rowY(o), W = xs[xs.length - 1], H = ys[ys.length - 1], tol = 5 / ed.view.scale;
      if (lx < -tol || lx > W + tol || ly < -tol || ly > H + tol) return null;
      for (let i = 1; i < xs.length - 1; i++) if (Math.abs(lx - xs[i]) <= tol) return { kind: "col", index: i - 1, edge: xs[i - 1] };
      for (let i = 1; i < ys.length - 1; i++) if (Math.abs(ly - ys[i]) <= tol) return { kind: "row", index: i - 1, edge: ys[i - 1] };
      return null;
    }
    function beginTableBorder(tb, pos) { snapshot(); const o = selObjects()[0]; action = { type: tb.kind === "col" ? "tcol" : "trow", id: o.id, pageIndex: ed.sel.pageIndex, index: tb.index, edge: tb.edge }; }

    // ---- pointer ---------------------------------------------------------
    const pointers = new Map(); let action = null, gesture = null;
    const getPos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener("pointerdown", (e) => { if (e.button === 2) return; canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, getPos(e)); if (pointers.size === 2) { beginGesture(); cancelSingle(); return; } if (pointers.size > 2) return; beginSingle(getPos(e), e); });
    // Right-click an object: select it (if not already) and let the app show an order/actions menu.
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const pos = getPos(e), d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y);
      if (!pl) return; const o = topObjectAt(pl.index, pl.lx, pl.ly); if (!o) return;
      if (!(ed.sel && ed.sel.pageIndex === pl.index && ed.sel.ids.includes(o.id))) setSelection(pl.index, [o.id]);
      if (opts.onObjectMenu) opts.onObjectMenu(e.clientX, e.clientY);
    });
    canvas.addEventListener("pointermove", (e) => { if (!pointers.has(e.pointerId)) return; pointers.set(e.pointerId, getPos(e)); if (pointers.size >= 2 && gesture) { moveGesture(); return; } if (action) moveSingle(getPos(e), e); });
    function up(e) { const had = pointers.has(e.pointerId); pointers.delete(e.pointerId); try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} if (gesture && pointers.size < 2) gesture = null; if (had && pointers.size === 0 && action) endSingle(getPos(e), e); }
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    function beginGesture() { const p = [...pointers.values()]; gesture = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 }; }
    function moveGesture() { const p = [...pointers.values()]; const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2; ed.view.panX += mx - gesture.mx; ed.view.panY += my - gesture.my; if (gesture.d > 0) zoomAt(mx, my, d / gesture.d); else render(); gesture = { d, mx, my }; }

    function beginSingle(pos, e) {
      const panning = ed.tool === "pan" || ed.spaceHeld || e.button === 1;
      const h = handleAt(pos.x, pos.y); if (h) { beginHandle(h, pos); return; }
      if (!panning && ed.tool === "select") { const tb = tableBorderAt(pos); if (tb) { beginTableBorder(tb, pos); return; } }
      for (const b of ed._pagebtns) if (Math.hypot(pos.x - b.cx, pos.y - b.cy) <= b.r + 3) { action = { type: "tap-pagebtn", index: b.index, pos }; return; }
      for (const s of ed._hotspots) if (Math.hypot(pos.x - s.cx, pos.y - s.cy) <= s.r + 4) { action = { type: "tap-hotspot", index: s.index, pos }; return; }
      const d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y), tool = ed.tool;
      if (panning) { action = { type: "pan", last: pos }; return; }
      if (!pl) { if (tool === "select") { setSelection(null, null); action = { type: "marquee", startPage: nearestPageIndex(d.y), start: pos }; } else action = { type: "pan", last: pos }; return; }
      // Follow a link inside a rich-text box: Ctrl/⌘-click, OR a click when that box
      // is already the selected object (first click selects, second click follows).
      if (tool === "select") { const o = topObjectAt(pl.index, pl.lx, pl.ly); if (o && o.type === "text" && o._links && o._links.length) { const alreadySel = ed.sel && ed.sel.pageIndex === pl.index && ed.sel.ids.length === 1 && ed.sel.ids[0] === o.id; if (e.ctrlKey || e.metaKey || alreadySel) { const b = objBox(o), cx = o.x + b.w / 2, cy = o.y + b.h / 2, r = rot(pl.lx - cx, pl.ly - cy, -(o.rotation || 0)); const href = linkAtLocal(o, r.x + b.w / 2, r.y + b.h / 2); if (href) { window.open(normUrl(href), "_blank", "noopener"); action = { type: "none" }; return; } } } }
      if (tool === "pen" || tool === "highlighter") { snapshot(); const cfg = tool === "highlighter" ? ed.highlighter : ed.pen; const stroke = { id: uid(), type: "stroke", mode: tool, color: cfg.color, size: cfg.size, points: [[pl.lx, pl.ly]] }; ed.doc.pages[pl.index].objects.push(stroke); action = { type: "draw", pageIndex: pl.index, stroke }; return; }
      if (tool === "eraser") { action = { type: "erase", snapped: false }; eraseAt(pl); return; }
      if (tool === "text") {
        // Text tool is one-shot: if you clicked on an existing text box, edit it;
        // otherwise drop ONE new box. Either way, revert to the select tool so the
        // next click doesn't keep spawning empty boxes.
        const hit = topObjectAt(pl.index, pl.lx, pl.ly);
        ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select");
        if (hit && (hit.type === "text" || hit.type === "code" || hit.type === "sticky")) { setSelection(pl.index, [hit.id]); editText(pl.index, hit.id); action = { type: "none" }; return; }
        snapshot(); const t = ed.textDefaults; const o = { id: uid(), type: "text", x: pl.lx, y: pl.ly, w: 260, rotation: 0, fontSize: t.fontSize, color: t.color, bold: t.bold, italic: t.italic, family: t.family, align: t.align || "left", text: "" }; ed.doc.pages[pl.index].objects.push(o); setSelection(pl.index, [o.id]); changed(); editText(pl.index, o.id); action = { type: "none" }; return;
      }
      const obj = topObjectAt(pl.index, pl.lx, pl.ly);
      if (obj) {
        const add = e.shiftKey || e.ctrlKey || e.metaKey;
        if (add && ed.sel && ed.sel.pageIndex === pl.index) { const set = new Set(ed.sel.ids); set.has(obj.id) ? set.delete(obj.id) : set.add(obj.id); setSelection(pl.index, [...set]); }
        else if (!(ed.sel && ed.sel.pageIndex === pl.index && ed.sel.ids.includes(obj.id))) setSelection(pl.index, [obj.id]);
        snapshot(); const objs = selObjects();
        action = { type: "move", pageIndex: pl.index, start: d, orig: objs.map((o) => ({ id: o.id, snap: clone(o) })) };
        ed._moving = { pageIndex: pl.index, ids: new Set(objs.map((o) => o.id)) };
      } else { setSelection(null, null); action = { type: "marquee", startPage: pl.index, start: pos }; }
    }
    function beginHandle(kind, pos) {
      snapshot(); const pi = ed.sel.pageIndex;
      if (kind === "group-resize") { const g = groupBBox(), cs = l2s(pi, g.x + g.w / 2, g.y + g.h / 2); action = { type: "group-resize", pageIndex: pi, center: cs, gcx: g.x + g.w / 2, gcy: g.y + g.h / 2, startDist: Math.hypot(pos.x - cs.x, pos.y - cs.y), orig: selObjects().map((o) => ({ id: o.id, snap: clone(o) })) }; return; }
      const o = selObjects()[0], b = objBox(o); const cs = l2s(pi, b.x + b.w / 2, b.y + b.h / 2);
      action = { type: kind === "rotate" ? "rotate" : "resize", handle: kind, pageIndex: pi, id: o.id, center: cs, orig: clone(o), startAng: Math.atan2(pos.y - cs.y, pos.x - cs.x), startDist: Math.hypot(pos.x - cs.x, pos.y - cs.y) };
    }
    function scaleObjFrom(o, s, cx, cy, f) {
      if (o.type === "stroke") { o.points = s.points.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]); o.size = Math.max(0.2, (s.size || 1) * f); return; }
      const sb = objBox(s), scx = s.x + sb.w / 2, scy = s.y + sb.h / 2, ncx = cx + (scx - cx) * f, ncy = cy + (scy - cy) * f;
      if (s.w != null) o.w = Math.max(8, s.w * f);
      if (s.h != null) o.h = Math.max(8, s.h * f);
      if (s.fontSize != null) o.fontSize = Math.max(4, s.fontSize * f);
      if (s.radius != null) o.radius = Math.max(0, s.radius * f);
      if (o.type === "table") { if (s.colW) o.colW = s.colW.map((w) => w * f); if (s.rowH) o.rowH = s.rowH.map((h) => h * f); o.fontSize = Math.max(6, (s.fontSize || 14) * f); }
      const nb = objBox(o); o.x = ncx - nb.w / 2; o.y = ncy - nb.h / 2;
    }

    function moveSingle(pos, e) {
      if (!action) return;
      if (action.type === "pan") { ed.view.panX += pos.x - action.last.x; ed.view.panY += pos.y - action.last.y; action.last = pos; render(); return; }
      if (action.type === "draw") { if (action._recognized) return; const p = ed.doc.pages[action.pageIndex], top = ed._pageTops[action.pageIndex]; const evs = (e && e.getCoalescedEvents) ? e.getCoalescedEvents() : null; const pushPt = (px, py) => { const d = s2d(px, py); action.stroke.points.push([d.x - pageLeft(p), d.y - top]); }; if (evs && evs.length) { const r = canvas.getBoundingClientRect(); evs.forEach((ev) => pushPt(ev.clientX - r.left, ev.clientY - r.top)); } else pushPt(pos.x, pos.y); render(); armHoldRecognizer(pos); return; }
      if (action.type === "erase") { const d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y); if (pl) eraseAt(pl); return; }
      if (action.type === "tcol") { const o = ed.doc.pages[action.pageIndex].objects.find((x) => x.id === action.id); const p = ed.doc.pages[action.pageIndex]; const lx = s2d(pos.x, pos.y).x - pageLeft(p) - o.x; tableCols(o)[action.index] = Math.max(20, lx - action.edge); render(); return; }
      if (action.type === "trow") { const o = ed.doc.pages[action.pageIndex].objects.find((x) => x.id === action.id); const ly = s2d(pos.x, pos.y).y - ed._pageTops[action.pageIndex] - o.y; tableRows(o)[action.index] = Math.max(16, ly - action.edge); render(); return; }
      if (action.type === "marquee") { ed._marquee = { x: Math.min(action.start.x, pos.x), y: Math.min(action.start.y, pos.y), w: Math.abs(pos.x - action.start.x), h: Math.abs(pos.y - action.start.y) }; render(); return; }
      if (action.type === "move") { const d = s2d(pos.x, pos.y), dx = d.x - action.start.x, dy = d.y - action.start.y, objs = ed.doc.pages[action.pageIndex].objects; action.orig.forEach((rec) => { const o = objs.find((x) => x.id === rec.id); if (!o) return; const s = rec.snap; if (o.type === "stroke") o.points = s.points.map(([x, y]) => [x + dx, y + dy]); else { o.x = s.x + dx; o.y = s.y + dy; } }); render(); return; }
      if (action.type === "group-resize") { const f = Math.max(0.05, Math.hypot(pos.x - action.center.x, pos.y - action.center.y) / (action.startDist || 1)); const objs = ed.doc.pages[action.pageIndex].objects; action.orig.forEach((rec) => { const o = objs.find((x) => x.id === rec.id); if (o) scaleObjFrom(o, rec.snap, action.gcx, action.gcy, f); }); render(); if (opts.onTransform) opts.onTransform(); return; }
      if (action.type === "resize") {
        const o = selObjects()[0], ob = action.orig;
        const hnd = action.handle;
        if (o.type === "text" || o.type === "code" || o.type === "table") {
          // width only — text wraps / the table stretches. Row count sets height.
          const p = ed.doc.pages[action.pageIndex], d = s2d(pos.x, pos.y);
          o.w = Math.max(o.type === "code" ? 120 : o.type === "table" ? 120 : 40, (d.x - pageLeft(p)) - o.x);
        } else if (o.type === "math") {
          const f = Math.max(0.1, Math.hypot(pos.x - action.center.x, pos.y - action.center.y) / (action.startDist || 1));
          const bb = objBox(ob), cx = ob.x + bb.w / 2, cy = ob.y + bb.h / 2, ow = ob.w || bb.w, oh = ob.h || bb.h;
          o.w = Math.max(20, ow * f); o.h = Math.max(16, oh * f); o.x = cx - o.w / 2; o.y = cy - o.h / 2;
        } else if (o.type === "image" || o.type === "chart" || o.type === "media" || o.type === "shape") {
          // corners = proportional, sides = single-axis (disproportionate) stretch
          const p = ed.doc.pages[action.pageIndex], d = s2d(pos.x, pos.y), bb = objBox(ob), cxL = ob.x + bb.w / 2, cyL = ob.y + bb.h / 2;
          const rel = rot((d.x - pageLeft(p)) - cxL, (d.y - ed._pageTops[action.pageIndex]) - cyL, -(ob.rotation || 0));
          let nw = ob.w, nh = ob.h;
          if (hnd === "h-l" || hnd === "h-r") nw = Math.max(20, 2 * Math.abs(rel.x));
          else if (hnd === "h-t" || hnd === "h-b") nh = Math.max(16, 2 * Math.abs(rel.y));
          else { const f = Math.max(0.05, Math.hypot(rel.x, rel.y) / Math.hypot(bb.w / 2, bb.h / 2)); nw = Math.max(20, ob.w * f); nh = Math.max(16, ob.h * f); }
          o.w = nw; o.h = nh; o.x = cxL - nw / 2; o.y = cyL - nh / 2;
        }
        render(); if (opts.onTransform) opts.onTransform(); return;
      }
      if (action.type === "rotate") { const o = selObjects()[0], ang = Math.atan2(pos.y - action.center.y, pos.x - action.center.x); o.rotation = (action.orig.rotation || 0) + (ang - action.startAng); render(); if (opts.onTransform) opts.onTransform(); return; }
    }
    function endSingle(pos, e) {
      const a = action; action = null; if (!a) return;
      if (a._holdTimer) { clearTimeout(a._holdTimer); a._holdTimer = null; }
      if (a.type === "tap-pagebtn") { if (Math.hypot(pos.x - a.pos.x, pos.y - a.pos.y) < 8 && opts.onPageMenu) { const b = ed._pagebtns.find((x) => x.index === a.index); opts.onPageMenu(a.index, b ? b.cx : pos.x, b ? b.cy : pos.y); } return; }
      if (a.type === "tap-hotspot") { if (Math.hypot(pos.x - a.pos.x, pos.y - a.pos.y) < 8) { snapshot(); insertBlank(a.index); } return; }
      if (a.type === "marquee") { const m = ed._marquee; ed._marquee = null; if (!m || (m.w < 4 && m.h < 4)) { render(); return; } const pi = a.startPage, p = ed.doc.pages[pi]; const tl = s2d(m.x, m.y), br = s2d(m.x + m.w, m.y + m.h); const rx1 = tl.x - pageLeft(p), ry1 = tl.y - ed._pageTops[pi], rx2 = br.x - pageLeft(p), ry2 = br.y - ed._pageTops[pi]; const hits = p.objects.filter((o) => { const bb = objAABB(o); return bb.x < rx2 && bb.x2 > rx1 && bb.y < ry2 && bb.y2 > ry1; }).map((o) => o.id); setSelection(pi, hits); return; }
      if (a.type === "move") { ed._moving = null; reassignMovedToPages(a.pageIndex); changed(); return; }
      if (a.type === "draw" || a.type === "erase" || a.type === "resize" || a.type === "rotate" || a.type === "tcol" || a.type === "trow" || a.type === "group-resize") changed();
    }
    // When objects are dragged onto another page, move them to belong to that page
    // so they draw ON TOP of it (a page's paper is always behind its own objects).
    function reassignMovedToPages(srcIdx) {
      const src = ed.doc.pages[srcIdx]; if (!src || !ed.sel || ed.sel.pageIndex !== srcIdx) return;
      const ids = ed.sel.ids.slice(), moves = [];
      ids.forEach((id) => {
        const o = src.objects.find((x) => x.id === id); if (!o) return;
        const b = objBox(o), cyDoc = ed._pageTops[srcIdx] + b.y + b.h / 2;
        let ti = -1; for (let i = 0; i < ed.doc.pages.length; i++) { const p = ed.doc.pages[i], top = ed._pageTops[i]; if (cyDoc >= top && cyDoc <= top + p.height) { ti = i; break; } }
        if (ti >= 0 && ti !== srcIdx) moves.push({ o, ti });
      });
      if (!moves.length) return;
      moves.forEach(({ o, ti }) => {
        const tgt = ed.doc.pages[ti], dx = pageLeft(src) - pageLeft(tgt), dy = ed._pageTops[srcIdx] - ed._pageTops[ti];
        if (o.type === "stroke") o.points = o.points.map(([x, y]) => [x + dx, y + dy]); else { o.x += dx; o.y += dy; }
        const i = src.objects.indexOf(o); if (i >= 0) src.objects.splice(i, 1); tgt.objects.push(o);
      });
      const ti = moves[0].ti;
      ed.sel = { pageIndex: ti, ids: ids.filter((id) => ed.doc.pages[ti].objects.find((o) => o.id === id)) };
    }
    function cancelSingle() { if (action && action._holdTimer) { clearTimeout(action._holdTimer); action._holdTimer = null; } if (action && action.type === "draw") { const objs = ed.doc.pages[action.pageIndex].objects; const i = objs.indexOf(action.stroke); if (i >= 0) objs.splice(i, 1); if (ed.undoStack.length) ed.undoStack.pop(); } if (action && action.type === "marquee") ed._marquee = null; ed._moving = null; action = null; render(); }
    function eraseAt(pl) { const objs = ed.doc.pages[pl.index].objects; let removed = false; for (let i = objs.length - 1; i >= 0; i--) if (objs[i].type === "stroke" && pointInObject(objs[i], pl.lx, pl.ly)) { if (action && !action.snapped) { snapshot(); action.snapped = true; } objs.splice(i, 1); removed = true; } if (removed) changed(); }

    canvas.addEventListener("wheel", (e) => { e.preventDefault(); const pos = getPos(e); if (e.ctrlKey || e.metaKey) zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * 0.0015)); else { ed.view.panX -= e.deltaX; ed.view.panY -= e.deltaY; render(); } }, { passive: false });

    // Double-click a box to edit it: text/code/sticky open inline; table/chart open a dialog.
    canvas.addEventListener("dblclick", (e) => {
      const pos = getPos(e), d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y); if (!pl) return;
      const o = topObjectAt(pl.index, pl.lx, pl.ly); if (!o) return;
      setSelection(pl.index, [o.id]);
      if (o.type === "text" || o.type === "code" || o.type === "sticky") editText(pl.index, o.id);
      else if ((o.type === "table" || o.type === "chart" || o.type === "math" || o.type === "media") && opts.onEditObject) opts.onEditObject(o.type);
    });

    // ---- text overlay ----------------------------------------------------
    let editingEl = null, editingRef = null, _richRange = null, _selHandler = null;
    function plainToHtml(o) { return (o.text || "").split("\n").map((l) => escapeHtml(l)).join("<br>"); }
    function looksLikeUrl(w) { return /^(https?:\/\/|ftp:\/\/)\S+$/i.test(w) || /^(mailto:|tel:)\S+$/i.test(w) || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(w) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([\/?#]\S*)?$/i.test(w); }

    function normUrl(w) { if (/^(https?:|mailto:|tel:|ftp:)/i.test(w)) return w; if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(w)) return "mailto:" + w; return "https://" + w.replace(/^\/+/, ""); }
    function saveRichSel() { const s = window.getSelection(); if (s.rangeCount && editingEl && editingEl.contains(s.anchorNode)) _richRange = s.getRangeAt(0).cloneRange(); }
    function restoreRichSel() { editingEl.focus(); if (_richRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(_richRange); } }
    function selectedText() { if (!isEditingRich()) return ""; const s = window.getSelection(); return s.rangeCount ? String(s) : ""; }
    function autoLinkify() {
      const s = window.getSelection(); if (!s.rangeCount) return null; const r = s.getRangeAt(0), node = r.startContainer;
      if (node.nodeType !== 3 || (node.parentElement && node.parentElement.closest("a"))) return null;
      const caret = r.startOffset, m = node.nodeValue.slice(0, caret).match(/(\S+)$/); if (!m || !looksLikeUrl(m[1])) return null;
      const word = m[1], wr = document.createRange(); wr.setStart(node, caret - word.length); wr.setEnd(node, caret);
      const a = document.createElement("a"); a.href = normUrl(word); a.textContent = word; wr.deleteContents(); wr.insertNode(a);
      const after = document.createRange(); after.setStartAfter(a); after.collapse(true); s.removeAllRanges(); s.addRange(after);
      const o = curEditingObj(); if (o) { o.html = editingEl.innerHTML; o.text = editingEl.textContent; }
      return a;
    }
    // Undo a just-created auto-link (first Backspace after it), unwrapping the <a> but keeping the text.
    function undoAutoLink() {
      const a = ed._autoLinkedEl; if (!a || !a.parentNode || !editingEl || !editingEl.contains(a)) { ed._autoLinkedEl = null; return; }
      const t = document.createTextNode(a.textContent); a.parentNode.replaceChild(t, a);
      const s = window.getSelection(), r = document.createRange(); r.setStart(t, t.length); r.collapse(true); s.removeAllRanges(); s.addRange(r);
      ed._autoLinkedEl = null; saveRichSel();
      const o = curEditingObj(); if (o) { o.html = editingEl.innerHTML; o.text = editingEl.textContent; }
      render(); if (opts.onChange) opts.onChange();
    }
    function editText(pageIndex, id) {
      commitText(); const o = ed.doc.pages[pageIndex].objects.find((x) => x.id === id); if (!o) return;
      let el, rich = (o.type === "text");
      if (rich) { if (o.html == null) o.html = plainToHtml(o); el = document.createElement("div"); el.className = "text-overlay rich"; el.contentEditable = "true"; el.spellcheck = true; el.innerHTML = o.html || ""; }
      else { el = document.createElement("textarea"); el.className = "text-overlay"; el.value = o.text || ""; }
      positionOverlay(el, pageIndex, o);
      const sync = () => { if (rich) { o.html = el.innerHTML; o.text = el.textContent; } else o.text = el.value; positionOverlay(el, pageIndex, o); render(); if (opts.onChange) opts.onChange(); };
      el.addEventListener("input", sync);
      // Only close the editor when focus leaves for something OTHER than a toolbar control.
      el.addEventListener("blur", () => setTimeout(() => { if (editingEl !== el) return; const ae = document.activeElement; if (ae === el || (ae && ae.closest && ae.closest("#toolbar, #link-modal, #marker-modal"))) return; commitText(); }, 0));
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); el.blur(); return; }
        if (!rich) return;
        // First Backspace right after an auto-link removes the link instead of a character.
        if (ev.key === "Backspace" && ed._autoLinkedEl) { ev.preventDefault(); undoAutoLink(); return; }
        if (ed._autoLinkedEl && ev.key !== "Shift" && ev.key !== "Meta" && ev.key !== "Control" && ev.key !== "Alt") ed._autoLinkedEl = null;
        if (ev.key === " " || ev.key === "Enter") { const a = autoLinkify(); if (a) ed._autoLinkedEl = a; }
      });
      if (rich) { _selHandler = () => saveRichSel(); document.addEventListener("selectionchange", _selHandler); }
      wrap.appendChild(el); editingEl = el; editingRef = { pageIndex, id, rich }; setTimeout(() => el.focus(), 0);
      if (opts.onEditText) opts.onEditText(rich);
    }
    function curEditingObj() { return editingRef ? ed.doc.pages[editingRef.pageIndex].objects.find((x) => x.id === editingRef.id) : null; }
    function isEditingRich() { return !!(editingEl && editingRef && editingRef.rich); }
    function styleSelection(cssProp, val) { const sel = window.getSelection(); if (!sel.rangeCount) return; const range = sel.getRangeAt(0); if (range.collapsed) return; const span = document.createElement("span"); span.style[cssProp] = val; try { range.surroundContents(span); } catch (e) { const frag = range.extractContents(); span.appendChild(frag); range.insertNode(span); } sel.removeAllRanges(); const nr = document.createRange(); nr.selectNodeContents(span); sel.addRange(nr); }
    function anchorAtCaret() { const s = window.getSelection(); if (!s.rangeCount) return null; let n = s.anchorNode; n = n && (n.nodeType === 3 ? n.parentElement : n); return n && n.closest ? n.closest("a") : null; }
    function syncFromEditingEl() { const o = curEditingObj(); if (o) { o.html = editingEl.innerHTML; o.text = editingEl.textContent; } editingEl.focus(); saveRichSel(); positionOverlay(editingEl, editingRef.pageIndex, curEditingObj()); render(); if (opts.onChange) opts.onChange(); }
    // Info for the link dialog: an existing link at the caret, or the selected text to link.
    function linkContext() { if (!isEditingRich()) return { inLink: false, text: "", url: "" }; restoreRichSel(); const a = anchorAtCaret(); if (a) return { inLink: true, text: a.textContent || "", url: a.getAttribute("href") || "" }; const s = window.getSelection(); return { inLink: false, text: s.rangeCount ? String(s) : "", url: "" }; }
    // Insert/update a link with explicit display text + url at the caret (or over the selection).
    function applyLink(text, url) {
      if (!isEditingRich() || !url) return; restoreRichSel();
      const href = normUrl(url.trim()), label = (text || "").trim() || url.trim(), s = window.getSelection();
      const existing = anchorAtCaret();
      if (existing) { existing.setAttribute("href", href); existing.textContent = label; }
      else if (s.rangeCount && !s.getRangeAt(0).collapsed && String(s) === label) { try { document.execCommand("styleWithCSS", false, true); } catch (e) {} document.execCommand("createLink", false, href); }
      else { const r = s.getRangeAt(0); r.deleteContents(); const a = document.createElement("a"); a.href = href; a.textContent = label; r.insertNode(a); const nr = document.createRange(); nr.setStartAfter(a); nr.collapse(true); s.removeAllRanges(); s.addRange(nr); }
      ed._autoLinkedEl = null; syncFromEditingEl();
    }
    function removeLink() {
      if (!isEditingRich()) return; restoreRichSel(); const a = anchorAtCaret();
      if (a) { const p = a.parentNode; while (a.firstChild) p.insertBefore(a.firstChild, a); p.removeChild(a); }
      else { try { document.execCommand("unlink"); } catch (e) {} }
      ed._autoLinkedEl = null; syncFromEditingEl();
    }
    function refocusText() { if (editingEl && editingRef && editingRef.rich) restoreRichSel(); }
    function richCommand(cmd, value) {
      if (!isEditingRich()) return false;
      restoreRichSel();
      try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
      if (cmd === "fontSize") styleSelection("fontSize", value);
      else if (cmd === "fontName") styleSelection("fontFamily", value);
      else if (cmd === "lineHeight") { const o = curEditingObj(); if (o) o.lineHeight = value; }
      else document.execCommand(cmd, false, value);
      saveRichSel();
      const o = curEditingObj(); if (o) { o.html = editingEl.innerHTML; o.text = editingEl.textContent; }
      positionOverlay(editingEl, editingRef.pageIndex, o); render(); if (opts.onChange) opts.onChange(); return true;
    }
    function positionOverlay(ta, pageIndex, o) {
      if (o.type === "sticky") {
        const p = l2s(pageIndex, o.x + 32, o.y); ta.style.left = p.x + "px"; ta.style.top = p.y + "px";
        ta.style.width = "230px"; ta.style.height = "140px"; ta.style.fontSize = "14px"; ta.style.fontFamily = "system-ui";
        ta.style.color = "#3a2f00"; ta.style.background = o.color || "#ffe08a"; ta.style.padding = "8px";
        ta.style.fontWeight = "400"; ta.style.fontStyle = "normal"; ta.style.transform = "none";
        ta.classList.add("sticky-overlay"); return;
      }
      // Position by CENTRE and rotate about the centre, matching how the canvas
      // draws the box — otherwise a rotated box drifts while it's being edited.
      const scale = ed.view.scale, th = (o.type === "code") ? codeHeight(o) : textHeight(o);
      const ow = o.w * scale, oh = th * scale, cs = l2s(pageIndex, o.x + o.w / 2, o.y + th / 2);
      ta.style.boxSizing = "border-box";
      ta.style.left = (cs.x - ow / 2) + "px"; ta.style.top = (cs.y - oh / 2) + "px";
      ta.style.width = ow + "px"; ta.style.height = oh + "px";
      ta.style.transformOrigin = "center center";
      ta.style.transform = `rotate(${o.rotation || 0}rad)`;
      if (o.type === "code") { ta.style.fontFamily = 'ui-monospace, Consolas, monospace'; ta.style.fontSize = (o.fontSize * scale) + "px"; ta.style.color = "#383a42"; ta.style.background = "rgba(246,248,250,.96)"; ta.style.padding = (8 * scale) + "px"; ta.style.fontWeight = "400"; ta.style.fontStyle = "normal"; ta.style.textAlign = "left"; }
      else { ta.style.fontFamily = (o.family || "system-ui"); ta.style.fontSize = (o.fontSize * scale) + "px"; ta.style.color = o.color; ta.style.fontWeight = o.bold ? "700" : "400"; ta.style.fontStyle = o.italic ? "italic" : "normal"; ta.style.background = "transparent"; ta.style.padding = "2px"; ta.style.textAlign = o.align || "left"; ta.style.lineHeight = String(o.lineHeight || 1.3); }
    }
    function commitText() {
      if (!editingEl) return; const el = editingEl; editingEl = null; editingRef = null; ed._autoLinkedEl = null;
      if (_selHandler) { document.removeEventListener("selectionchange", _selHandler); _selHandler = null; } _richRange = null;
      el.remove();
      // Empty boxes are kept on purpose (so you can size them before typing and
      // re-open them later); a faint placeholder keeps them visible. Delete with Del.
      changed();
    }

    // ---- pages -----------------------------------------------------------
    function ensureDefaults() { if (!ed.doc.defaults) ed.doc.defaults = { pageColor: "#ffffff", ruled: false }; ed.doc.pages.forEach((p) => { p.objects = p.objects || []; if (p.bgColor === undefined) p.bgColor = "#ffffff"; if (p.ruled === undefined) p.ruled = false; p.objects.forEach((o) => { if (o.type === "text" && o.html != null) o.html = sanitizeRich(o.html); }); }); }
    function newBlankPage(w, h) { const d = ed.doc.defaults || {}; return { id: uid(), width: w || DEFAULT_W, height: h || DEFAULT_H, bgColor: d.pageColor || "#ffffff", ruled: !!d.ruled, background: null, objects: [] }; }
    function insertBlank(index, w, h) { const ref = ed.doc.pages[Math.min(index, ed.doc.pages.length - 1)]; ed.doc.pages.splice(index, 0, newBlankPage(w || (ref ? ref.width : DEFAULT_W), h || (ref ? ref.height : DEFAULT_H))); changed(); if (opts.onToast) opts.onToast("Page added"); }
    function addPage(spec) { spec = spec || {}; snapshot(); const cur = currentPageIndex(); let index = (typeof spec.index === "number") ? spec.index : cur + 1; if (spec.position === "before") index = cur; else if (spec.position === "start") index = 0; else if (spec.position === "end") index = ed.doc.pages.length; insertBlank(index, spec.width, spec.height); }
    function deletePage(index) { if (typeof index !== "number") index = currentPageIndex(); if (ed.doc.pages.length <= 1) { if (opts.onToast) opts.onToast("A note needs at least one page"); return; } snapshot(); ed.doc.pages.splice(index, 1); setSelection(null, null); changed(); if (opts.onToast) opts.onToast("Page deleted"); }
    function resizePage(index, w, h) { if (typeof index !== "number") index = currentPageIndex(); const p = ed.doc.pages[index]; if (!p) return; snapshot(); p.width = Math.max(100, Math.round(w)); p.height = Math.max(100, Math.round(h)); p.background = null; fitWidth(); changed(); }
    function resizeAllPages(w, h) { snapshot(); ed.doc.pages.forEach((p) => { p.width = Math.max(100, Math.round(w)); p.height = Math.max(100, Math.round(h)); p.background = null; }); fitWidth(); changed(); }
    async function rotatePage(index) { if (typeof index !== "number") index = currentPageIndex(); const p = ed.doc.pages[index]; if (!p) return; snapshot(); rotatePageObj(p); setSelection(null, null); fitWidth(); changed(); if (p.background) { p.background = await rotateImageDataURL(p.background); render(); if (opts.onChange) opts.onChange(); } }
    async function rotateAllPages() { snapshot(); for (const p of ed.doc.pages) { rotatePageObj(p); if (p.background) p.background = await rotateImageDataURL(p.background); } setSelection(null, null); fitWidth(); changed(); }
    function rotatePageObj(p) { const W = p.width, H = p.height, map = ([x, y]) => [H - y, x]; p.objects.forEach((o) => { if (o.type === "stroke") o.points = o.points.map(map); else { const b = objBox(o), cx = o.x + b.w / 2, cy = o.y + b.h / 2, nc = map([cx, cy]); o.rotation = (o.rotation || 0) + Math.PI / 2; o.x = nc[0] - b.w / 2; o.y = nc[1] - b.h / 2; } }); p.width = H; p.height = W; }
    function setPageBg(index, color) { if (typeof index !== "number") index = currentPageIndex(); const p = ed.doc.pages[index]; if (!p) return; snapshot(); p.bgColor = color; changed(); }
    function setAllPagesBg(color) { snapshot(); ed.doc.pages.forEach((p) => (p.bgColor = color)); changed(); }
    function setPageRuled(index, on) { if (typeof index !== "number") index = currentPageIndex(); const p = ed.doc.pages[index]; if (!p) return; snapshot(); p.ruled = !!on; changed(); }
    function setAllRuled(on) { snapshot(); ed.doc.pages.forEach((p) => (p.ruled = !!on)); changed(); }
    function setDefaults(d) { ed.doc.defaults = Object.assign(ed.doc.defaults || {}, d); ed.dirty = true; if (opts.onChange) opts.onChange(); }
    function pageRuled(index) { const p = ed.doc.pages[typeof index === "number" ? index : currentPageIndex()]; return p ? !!p.ruled : false; }

    // ---- images / import -------------------------------------------------
    function addImageFromFile(file, atIndex) {
      const reader = new FileReader();
      reader.onload = () => { const img = new Image(); img.onload = () => { snapshot(); const pageIndex = typeof atIndex === "number" ? atIndex : currentPageIndex(); const p = ed.doc.pages[pageIndex]; const scale = Math.min(1, (p.width * 0.6) / img.width); const w = img.width * scale, h = img.height * scale; const o = { id: uid(), type: "image", x: (p.width - w) / 2, y: Math.max(20, (p.height - h) / 2), w, h, rotation: 0, src: reader.result }; p.objects.push(o); getImage(o.src); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); }; img.src = reader.result; };
      reader.readAsDataURL(file);
    }
    function addCode() { snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex]; const d = ed.codeDefaults; const y = Math.max(40, s2d(wrap.clientWidth / 2, 90).y - ed._pageTops[pageIndex]); const o = { id: uid(), type: "code", x: p.width * 0.12, y, w: p.width * 0.76, rotation: 0, fontSize: d.fontSize, language: d.language, text: "" }; p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); editText(pageIndex, o.id); }
    function addSticky() { snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex]; const y = Math.max(30, s2d(wrap.clientWidth / 2, 80).y - ed._pageTops[pageIndex]); const o = { id: uid(), type: "sticky", x: p.width / 2 - 14, y, color: "#ffe08a", text: "" }; p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); editText(pageIndex, o.id); }
    function newVisiblePos(pageIndex, frac) { return Math.max(30, s2d(wrap.clientWidth / 2, wrap.clientHeight * (frac || 0.25)).y - ed._pageTops[pageIndex]); }
    function addShape(kind) {
      snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex];
      const w = kind === "line" ? 220 : 160, h = kind === "line" ? 130 : (kind === "triangle" || kind === "diamond" ? 150 : 120);
      const o = { id: uid(), type: "shape", shape: kind, x: (p.width - w) / 2, y: newVisiblePos(pageIndex, 0.3), w, h, rotation: 0,
        fill: kind === "line" ? null : "rgba(91,124,250,0.14)", stroke: ed.pen.color || "#1a1a1a", strokeWidth: kind === "line" ? 3 : 2, lineDir: 1 };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); return o;
    }
    function setShapeProp(prop, val) {
      if (!ed.sel || ed.sel.ids.length !== 1) return; const o = selObjects()[0]; if (!o || o.type !== "shape") return;
      snapshot();
      if (prop === "w" || prop === "h") o[prop] = Math.max(4, val);
      else if (prop === "strokeWidth") o.strokeWidth = Math.max(0, val);
      else if (prop === "rotation") o.rotation = (val || 0) * Math.PI / 180;
      else o[prop] = val;
      changed();
    }
    function shapeInfo() { if (!ed.sel || ed.sel.ids.length !== 1) return null; const o = selObjects()[0]; if (!o || o.type !== "shape") return null; return { shape: o.shape, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth || 0, w: Math.round(o.w), h: Math.round(o.h), rotationDeg: Math.round((o.rotation || 0) * 180 / Math.PI) }; }

    // ---- geometry (W / H / rotation) for ANY selection --------------------
    // These height-is-automatic types wrap/grow to fit their content.
    const AUTO_H = { text: 1, code: 1, table: 1 };
    // Which objects can have their corners rounded (rect/triangle/diamond shapes, images, media).
    function canRound(o) { return o.type === "image" || o.type === "media" || (o.type === "shape" && (o.shape === "rect" || o.shape === "triangle" || o.shape === "diamond")); }
    function geometryInfo() {
      if (!ed.sel || !ed.sel.ids.length) return null; const objs = selObjects(); if (!objs.length) return null;
      if (objs.length === 1) { const o = objs[0], b = objBox(o); return { count: 1, type: o.type, w: Math.round(b.w), h: Math.round(b.h), rotationDeg: Math.round((o.rotation || 0) * 180 / Math.PI), autoH: !!AUTO_H[o.type], canRotate: o.type !== "sticky", canSize: o.type !== "sticky", canRound: canRound(o), radius: Math.round(o.radius != null ? o.radius : (o.type === "media" ? 10 : 0)) }; }
      const g = groupBBox(); return { count: objs.length, type: "group", w: Math.round(g.w), h: Math.round(g.h), rotationDeg: Math.round((ed.sel._rot || 0) * 180 / Math.PI), autoH: false, canRotate: true, canSize: true, canRound: false, radius: 0 };
    }
    function setCornerRadius(r) { if (!ed.sel || ed.sel.ids.length !== 1) return; const o = selObjects()[0]; if (!o || !canRound(o)) return; snapshot(); o.radius = Math.max(0, r || 0); changed(); if (opts.onTransform) opts.onTransform(); }
    function scaleObjXY(o, ox, oy, fx, fy) {
      if (o.type === "stroke") { o.points = o.points.map(([x, y]) => [ox + (x - ox) * fx, oy + (y - oy) * fy]); o.size = Math.max(0.2, (o.size || 1) * (fx + fy) / 2); return; }
      o.x = ox + (o.x - ox) * fx; o.y = oy + (o.y - oy) * fy;
      if (o.w != null) o.w = Math.max(6, o.w * fx);
      if (o.h != null) o.h = Math.max(6, o.h * fy);
      if (o.fontSize != null) o.fontSize = Math.max(4, o.fontSize * Math.min(fx, fy));
      if (o.radius != null) o.radius = Math.max(0, o.radius * Math.min(fx, fy));
      if (o.type === "table") { if (o.colW) o.colW = o.colW.map((w) => w * fx); if (o.rowH) o.rowH = o.rowH.map((h) => h * fy); }
    }
    function resizeObjTo(o, w, h) {
      const b = objBox(o), cx = o.x != null ? o.x + b.w / 2 : b.x + b.w / 2, cy = o.y != null ? o.y + b.h / 2 : b.y + b.h / 2;
      if (o.type === "stroke") { const sc = b, scx = sc.x + sc.w / 2, scy = sc.y + sc.h / 2; scaleObjXY(o, scx, scy, w != null ? w / (sc.w || 1) : 1, h != null ? h / (sc.h || 1) : 1); return; }
      if (o.type === "sticky") return;
      if (AUTO_H[o.type]) { if (w != null) o.w = Math.max(o.type === "code" ? 120 : 40, w); return; } // width only; height is automatic
      if (w != null && o.w != null) { o.w = Math.max(6, w); o.x = cx - o.w / 2; }
      if (h != null && o.h != null) { o.h = Math.max(6, h); o.y = cy - o.h / 2; }
      if (o.type === "math") { if (w != null) o.w = Math.max(20, w); if (h != null) o.h = Math.max(16, h); }
    }
    function setSelSize(w, h) {
      if (!ed.sel || !ed.sel.ids.length) return; const objs = selObjects(); if (!objs.length) return; snapshot();
      if (objs.length === 1) resizeObjTo(objs[0], (w != null && w > 0) ? w : null, (h != null && h > 0) ? h : null);
      else { const g = groupBBox(); const fx = (w != null && w > 0) ? Math.max(0.02, w / (g.w || 1)) : 1, fy = (h != null && h > 0) ? Math.max(0.02, h / (g.h || 1)) : 1; objs.forEach((o) => scaleObjXY(o, g.x, g.y, fx, fy)); }
      changed(); if (opts.onTransform) opts.onTransform();
    }
    function rotatePoints(o, cx, cy, d) { o.points = o.points.map(([x, y]) => { const r = rot(x - cx, y - cy, d); return [cx + r.x, cy + r.y]; }); }
    function setSelRotation(deg) {
      if (!ed.sel || !ed.sel.ids.length) return; const objs = selObjects(); if (!objs.length) return; snapshot();
      const rad = (deg || 0) * Math.PI / 180;
      if (objs.length === 1) { objs[0].rotation = rad; }
      else { const g = groupBBox(), gcx = g.x + g.w / 2, gcy = g.y + g.h / 2, delta = rad - (ed.sel._rot || 0); objs.forEach((o) => { if (o.type === "stroke") rotatePoints(o, gcx, gcy, delta); else { const b = objBox(o), ocx = o.x + b.w / 2, ocy = o.y + b.h / 2, p = rot(ocx - gcx, ocy - gcy, delta); o.x = gcx + p.x - b.w / 2; o.y = gcy + p.y - b.h / 2; o.rotation = (o.rotation || 0) + delta; } }); ed.sel._rot = rad; }
      changed(); if (opts.onTransform) opts.onTransform();
    }

    // ---- freehand shape recognition (draw + hold to snap) ----------------
    function _perpDist(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l; }
    function _rdp(pts, eps) {
      if (pts.length < 3) return pts.slice();
      const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true; const stack = [[0, pts.length - 1]];
      while (stack.length) { const [s, e] = stack.pop(); let idx = -1, dmax = 0; for (let i = s + 1; i < e; i++) { const d = _perpDist(pts[i], pts[s], pts[e]); if (d > dmax) { dmax = d; idx = i; } } if (dmax > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); } }
      const out = []; for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]); return out;
    }
    function recognizeShape(rawPts) {
      if (!rawPts || rawPts.length < 6) return null;
      const P = rawPts.map((p) => ({ x: p[0], y: p[1] }));
      const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const w = maxX - minX, h = maxY - minY, diag = Math.hypot(w, h);
      if (diag < 26) return null;
      const start = P[0], end = P[P.length - 1], gap = Math.hypot(end.x - start.x, end.y - start.y);
      const closed = gap < diag * 0.28;
      let maxPerp = 0; for (const p of P) maxPerp = Math.max(maxPerp, _perpDist(p, start, end));
      // near-straight, open -> line
      if (!closed && maxPerp < diag * 0.16) {
        const lineDir = ((end.y - start.y) * (end.x - start.x) >= 0) ? 1 : -1;
        return { shape: "line", x: minX, y: minY, w: Math.max(4, w), h: Math.max(4, h), lineDir };
      }
      // every other shape must be a roughly closed outline — a scribble is neither
      // straight nor closed, so it stays ink.
      if (!closed) return null;
      let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
      if (len > 2.4 * 2 * (w + h)) return null; // path far longer than the box perimeter -> too wiggly for a clean shape
      const box = { x: minX, y: minY, w: Math.max(8, w), h: Math.max(8, h) };
      let V = _rdp(P, diag * 0.05);
      if (V.length > 1 && Math.hypot(V[V.length - 1].x - V[0].x, V[V.length - 1].y - V[0].y) < diag * 0.09) V.pop();
      const corners = V.length;
      // Fraction of the bounding box the outline encloses (shoelace / box area):
      // rectangle ≈ 1.0, ellipse ≈ 0.79 (π/4), triangle & diamond ≈ 0.5.
      let area2 = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area2 += a.x * b.y - b.x * a.y; }
      const fill = Math.abs(area2) / 2 / (w * h || 1);
      if (corners === 3) return { shape: "triangle", ...box };
      if (fill > 0.80) return { shape: "rect", ...box };
      if (fill < 0.63) return { shape: corners <= 3 ? "triangle" : "diamond", ...box };
      return { shape: "ellipse", ...box }; // ~0.79 fill
    }
    function toRgba(color, a) {
      if (!color) return `rgba(0,0,0,${a})`;
      if (color[0] === "#") { let h = color.slice(1); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
      const m = color.match(/(\d+),\s*(\d+),\s*(\d+)/); return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : color;
    }
    let HOLD_MS = 550;
    function armHoldRecognizer(pos) {
      if (!action || action.type !== "draw" || action._recognized || (ed.tool !== "pen" && ed.tool !== "highlighter")) return;
      const moved = action._holdPos ? Math.hypot(pos.x - action._holdPos.x, pos.y - action._holdPos.y) : Infinity;
      if (moved <= 5 && action._holdTimer) return; // still holding — let the running timer fire
      action._holdPos = pos;
      if (action._holdTimer) clearTimeout(action._holdTimer);
      action._holdTimer = setTimeout(tryHoldRecognize, HOLD_MS);
    }
    function tryHoldRecognize() {
      if (!action || action.type !== "draw" || action._recognized) return;
      const stroke = action.stroke, shp = recognizeShape(stroke.points);
      if (!shp) return; // not close to any shape — keep the ink
      action._recognized = true; if (action._holdTimer) { clearTimeout(action._holdTimer); action._holdTimer = null; }
      const p = ed.doc.pages[action.pageIndex], i = p.objects.indexOf(stroke); if (i < 0) return;
      const isHL = stroke.mode === "highlighter", col = stroke.color || ed.pen.color, isLine = shp.shape === "line";
      // Highlighter snaps to a translucent highlight: a filled blob, or a thick see-through line.
      const so = { id: uid(), type: "shape", shape: shp.shape, x: shp.x, y: shp.y, w: shp.w, h: shp.h, rotation: 0,
        fill: (isHL && !isLine) ? toRgba(col, 0.3) : null,
        stroke: (isHL && !isLine) ? null : (isHL ? toRgba(col, 0.4) : col),
        strokeWidth: (isHL && !isLine) ? 0 : Math.max(1, stroke.size || (isHL ? ed.highlighter.size : ed.pen.size) || 2),
        lineDir: shp.lineDir || 1 };
      p.objects.splice(i, 1, so);
      const pi = action.pageIndex; action = { type: "none" };
      ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select");
      setSelection(pi, [so.id]); changed();
      if (opts.onToast) opts.onToast("Snapped to " + (shp.shape === "rect" ? "rectangle" : shp.shape));
    }
    function addTable() {
      snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex];
      const o = { id: uid(), type: "table", x: p.width * 0.12, y: newVisiblePos(pageIndex), w: p.width * 0.76, rotation: 0, rows: 3, cols: 3, headerRow: true, headerFill: "#eef1ff", altFill: null, gridColor: "#c9cede", textColor: "#1a1a1a", fontSize: 14, align: "left", data: [["Column 1", "Column 2", "Column 3"], ["", "", ""], ["", "", ""]] };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); return o.id;
    }
    function _placeMedia(mediaType, src, name) {
      snapshot(); const pi = currentPageIndex(), p = ed.doc.pages[pi]; const w = mediaType === "video" ? 320 : 240, h = mediaType === "video" ? 200 : 96;
      const o = { id: uid(), type: "media", mediaType, x: (p.width - w) / 2, y: newVisiblePos(pi, 0.25), w, h, rotation: 0, src, name: name || mediaType };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pi, [o.id]); changed(); return o.id;
    }
    // src is a server URL (preferred — plays/seeks reliably) already uploaded by the app.
    function addMediaUrl(mediaType, url, name) { return _placeMedia(mediaType, url, name); }
    // fallback: embed as a data URL (kept for anything not routed through the uploader)
    function addMedia(mediaType, fileOrBlob, name) {
      const reader = new FileReader();
      reader.onload = () => _placeMedia(mediaType, reader.result, name || fileOrBlob.name);
      reader.readAsDataURL(fileOrBlob);
    }
    function addChart() {
      snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex];
      const o = { id: uid(), type: "chart", chartType: "bar", x: p.width * 0.12, y: newVisiblePos(pageIndex), w: p.width * 0.5, h: 240, rotation: 0, title: "Chart", barWidth: 0.66,
        points: [{ label: "A", value: 8, color: "#5b7cfa" }, { label: "B", value: 5, color: "#e4576b" }, { label: "C", value: 12, color: "#2ca24c" }],
        categories: ["A", "B", "C"], series: [{ name: "Series 1", color: "#5b7cfa", values: [8, 5, 12] }] };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); return o.id;
    }
    function addMath() {
      snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex];
      const o = { id: uid(), type: "math", x: p.width * 0.12, y: newVisiblePos(pageIndex, 0.2), w: 160, h: 44, rotation: 0, color: "#1a1a1a", latex: "", src: "" };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed();
      if (opts.onEditObject) opts.onEditObject("math"); return o.id;
    }
    // render LaTeX -> stored image on the selected math object
    function setMathLatex(latex) {
      if (!ed.sel || ed.sel.ids.length !== 1) return; const o = selObjects()[0]; if (!o || o.type !== "math") return;
      const r = renderMathSvg(latex, o.color || "#1a1a1a");
      snapshot();
      o.latex = latex;
      if (r) { o.src = r.src; const cur = o.h || 44, scale = cur / r.h; o.w = r.w * scale; o.h = cur; } else { o.src = ""; }
      changed();
    }

    async function importPdf(file, insertAt) {
      if (!window.pdfjsLib) { opts.onToast && opts.onToast("PDF library not available"); return; }
      opts.onBusy && opts.onBusy(true, "Importing PDF…");
      try {
        const buf = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({ data: buf }).promise; const newPages = [];
        for (let n = 1; n <= pdf.numPages; n++) { if (opts.onBusy) opts.onBusy(true, `Importing page ${n} / ${pdf.numPages}…`); const page = await pdf.getPage(n); const vp = page.getViewport({ scale: 1 }); const rv = page.getViewport({ scale: 2 }); const oc = document.createElement("canvas"); oc.width = rv.width; oc.height = rv.height; await page.render({ canvasContext: oc.getContext("2d"), viewport: rv }).promise; newPages.push({ id: uid(), width: Math.round(vp.width), height: Math.round(vp.height), bgColor: "#ffffff", ruled: false, background: oc.toDataURL("image/jpeg", 0.85), objects: [] }); await new Promise((r) => setTimeout(r)); }
        snapshot();
        if (typeof insertAt === "number") ed.doc.pages.splice(insertAt, 0, ...newPages);
        else { const onlyEmpty = ed.doc.pages.length === 1 && !ed.doc.pages[0].background && ed.doc.pages[0].objects.length === 0; if (onlyEmpty) ed.doc.pages = newPages; else ed.doc.pages.push(...newPages); }
        fitWidth(); changed(); opts.onToast && opts.onToast(`Imported ${pdf.numPages} page${pdf.numPages > 1 ? "s" : ""}`);
      } catch (err) { console.error(err); opts.onToast && opts.onToast("Could not read that PDF"); } finally { opts.onBusy && opts.onBusy(false); }
    }

    // ---- selection ops ---------------------------------------------------
    let clipboard = null;
    function copySelection() { const objs = selObjects(); if (!objs.length) return false; clipboard = objs.map((o) => clone(o)); return true; }
    function hasClipboard() { return !!(clipboard && clipboard.length); }
    function pasteClipboard() {
      if (!clipboard || !clipboard.length) return; snapshot();
      const pi = currentPageIndex(), page = ed.doc.pages[pi], newIds = [];
      clipboard.forEach((src) => {
        const o = clone(src); o.id = uid();
        if (o.type === "stroke") o.points = o.points.map(([x, y]) => [x + 24, y + 24]); else { o.x = (o.x || 0) + 24; o.y = (o.y || 0) + 24; }
        page.objects.push(o); newIds.push(o.id);
      });
      setSelection(pi, newIds); changed();
      // keep a fresh copy so repeated pastes keep offsetting
      clipboard = newIds.map((id) => clone(page.objects.find((o) => o.id === id)));
    }
    function deleteSelection() { if (!ed.sel) return; snapshot(); const page = ed.doc.pages[ed.sel.pageIndex], ids = new Set(ed.sel.ids); page.objects = page.objects.filter((o) => !ids.has(o.id)); setSelection(null, null); changed(); }
    function applyColorToSelection(color) {
      if (!ed.sel) return false; let touched = false; snapshot();
      selObjects().forEach((o) => {
        if (o.type === "stroke" || o.type === "text" || o.type === "sticky") { o.color = color; touched = true; }
        else if (o.type === "math") { o.color = color; const r = renderMathSvg(o.latex || "", color); if (r) { o.src = r.src; } touched = true; }
        else if (o.type === "table") { o.gridColor = color; touched = true; }
        else if (o.type === "chart") { (o.points || []).forEach((p) => (p.color = color)); (o.series || []).forEach((s) => (s.color = color)); touched = true; }
        else if (o.type === "shape") { o.stroke = color; touched = true; }
      });
      if (touched) changed(); else ed.undoStack.pop(); return touched;
    }
    function setTextProp(prop, value) { if (prop !== "highlight") ed.textDefaults[prop] = value; if (ed.sel) { let touched = false; snapshot(); selObjects().forEach((o) => { if (o.type === "text" && ["fontSize", "color", "bold", "italic", "family", "highlight", "align", "strike", "underline", "lineHeight"].includes(prop)) { o[prop] = value; touched = true; } }); if (!touched) ed.undoStack.pop(); else changed(); } }
    function getSelected() { if (!ed.sel || ed.sel.ids.length !== 1) return null; const o = selObjects()[0]; return o ? clone(o) : null; }
    function updateSelected(patch) { if (!ed.sel || ed.sel.ids.length !== 1) return; const o = selObjects()[0]; if (!o) return; snapshot(); Object.assign(o, patch); changed(); }
    function setStickyColor(color) { if (!ed.sel) return; let t = false; snapshot(); selObjects().forEach((o) => { if (o.type === "sticky") { o.color = color; t = true; } }); if (t) changed(); else ed.undoStack.pop(); }
    function setCodeLanguage(lang) { ed.codeDefaults.language = lang; if (ed.sel) { let t = false; snapshot(); selObjects().forEach((o) => { if (o.type === "code") { o.language = lang; t = true; } }); if (t) changed(); else ed.undoStack.pop(); } }
    function rotateSelection() { if (!ed.sel) return; const objs = selObjects(); if (!objs.length) return; snapshot(); let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; objs.forEach((o) => { const bb = objAABB(o); x1 = Math.min(x1, bb.x); y1 = Math.min(y1, bb.y); x2 = Math.max(x2, bb.x2); y2 = Math.max(y2, bb.y2); }); const px = (x1 + x2) / 2, py = (y1 + y2) / 2, a = Math.PI / 2; objs.forEach((o) => { if (o.type === "stroke") o.points = o.points.map(([x, y]) => { const r = rot(x - px, y - py, a); return [r.x + px, r.y + py]; }); else { const b = objBox(o), cx = o.x + b.w / 2, cy = o.y + b.h / 2, r = rot(cx - px, cy - py, a); o.rotation = (o.rotation || 0) + a; o.x = (r.x + px) - b.w / 2; o.y = (r.y + py) - b.h / 2; } }); changed(); }
    function reorderSelection(toFront) { if (!ed.sel) return; snapshot(); const page = ed.doc.pages[ed.sel.pageIndex], ids = new Set(ed.sel.ids); const picked = page.objects.filter((o) => ids.has(o.id)), rest = page.objects.filter((o) => !ids.has(o.id)); page.objects = toFront ? [...rest, ...picked] : [...picked, ...rest]; changed(); }
    function stepSelection(dir) {
      if (!ed.sel) return; snapshot(); const objs = ed.doc.pages[ed.sel.pageIndex].objects, ids = new Set(ed.sel.ids);
      if (dir > 0) { for (let i = objs.length - 2; i >= 0; i--) if (ids.has(objs[i].id) && !ids.has(objs[i + 1].id)) { const t = objs[i]; objs[i] = objs[i + 1]; objs[i + 1] = t; } }
      else { for (let i = 1; i < objs.length; i++) if (ids.has(objs[i].id) && !ids.has(objs[i - 1].id)) { const t = objs[i]; objs[i] = objs[i - 1]; objs[i - 1] = t; } }
      changed();
    }
    function selectionInfo() { const objs = selObjects(); const types = new Set(objs.map((o) => o.type)); const info = { count: objs.length, types: [...types] }; if (objs.length === 1) { const o = objs[0]; info.obj = { type: o.type, fontSize: o.fontSize, color: o.color, bold: o.bold, italic: o.italic, family: o.family, language: o.language, highlight: o.highlight, align: o.align, lineHeight: o.lineHeight, shape: o.shape }; } return info; }

    // ---- export ----------------------------------------------------------
    async function exportPdfBlob() {
      await preloadAll(); const { jsPDF } = window.jspdf; let pdf = null; const PXPT = 72 / 96;
      for (let i = 0; i < ed.doc.pages.length; i++) {
        const p = ed.doc.pages[i], wpt = p.width * PXPT, hpt = p.height * PXPT, orient = wpt > hpt ? "l" : "p";
        if (i === 0) pdf = new jsPDF({ unit: "pt", format: [wpt, hpt], orientation: orient }); else pdf.addPage([wpt, hpt], orient);
        if (p.background && p.objects.length === 0 && (p.bgColor === "#ffffff" || !p.bgColor)) pdf.addImage(p.background, "JPEG", 0, 0, wpt, hpt);
        else { const sf = 2, oc = document.createElement("canvas"); oc.width = Math.round(p.width * sf); oc.height = Math.round(p.height * sf); const c = oc.getContext("2d"); c.scale(sf, sf); drawPageContents(c, p); pdf.addImage(oc.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, wpt, hpt); }
        // make rich-text links clickable in the PDF (unrotated boxes)
        p.objects.forEach((o) => { if (o.type === "text" && o.html != null && o._links && !(o.rotation)) { o._links.forEach((L) => { pdf.link((o.x + L.x) * PXPT, (o.y + L.y) * PXPT, L.w * PXPT, L.h * PXPT, { url: normUrl(L.href) }); }); } });
        await new Promise((r) => setTimeout(r));
      }
      return pdf ? pdf.output("blob") : null;
    }

    // ---- public ----------------------------------------------------------
    function loadDoc(doc) { commitText(); ed.doc = doc && doc.pages && doc.pages.length ? doc : { pages: [newBlankPage()], defaults: { pageColor: "#ffffff", ruled: false } }; ensureDefaults(); ed.sel = null; ed.dirty = false; ed.undoStack.length = 0; ed.redoStack.length = 0; fitWidth(); ed._needFit = wrap.clientWidth < 50; layout(); render(); if (opts.onPages) opts.onPages(ed.doc.pages.length, currentPageIndex() + 1); if (opts.onSelect) opts.onSelect(0); if (opts.onHistory) opts.onHistory(false, false); }
    function getColors() { return { pen: ed.pen.color, highlighter: ed.highlighter.color, text: ed.textDefaults.color }; }
    function setColors(c) { if (!c) return; if (c.pen) ed.pen.color = c.pen; if (c.highlighter) ed.highlighter.color = c.highlighter; if (c.text) ed.textDefaults.color = c.text; }
    function getDoc() { if (editingEl && editingRef) { const o = ed.doc.pages[editingRef.pageIndex] && ed.doc.pages[editingRef.pageIndex].objects.find((x) => x.id === editingRef.id); if (o) { if (editingRef.rich) { o.html = editingEl.innerHTML; o.text = editingEl.textContent; } else o.text = editingEl.value; } } return ed.doc; }

    const ro = new ResizeObserver(() => { if (ed._needFit && wrap.clientWidth >= 50) { ed._needFit = false; fitWidth(); } render(); }); ro.observe(wrap);

    return {
      loadDoc, getDoc, exportPdfBlob, importPdf, addImageFromFile, addCode, addSticky, addTable, addChart, addMath, addMedia, addMediaUrl,
      addShape, setShapeProp, shapeInfo,
      geometryInfo, setSelSize, setSelRotation, setCornerRadius,
      getSelected, updateSelected, setMathLatex, getColors, setColors,
      renderMath: (latex, color) => renderMathSvg(latex, color),
      addPage, deletePage, resizePage, rotatePage, resizeAllPages, rotateAllPages,
      setPageBg, setAllPagesBg, setPageRuled, setAllRuled, setDefaults, pageRuled,
      currentPage: () => currentPageIndex(),
      pageSize: (i) => { const p = ed.doc.pages[typeof i === "number" ? i : currentPageIndex()]; return p ? { w: p.width, h: p.height } : null; },
      pageColor: (i) => { const p = ed.doc.pages[typeof i === "number" ? i : currentPageIndex()]; return p ? (p.bgColor || "#ffffff") : "#ffffff"; },
      setTool(t) { commitText(); ed.tool = t; if (t !== "select") setSelection(null, null); render(); },
      tool: () => ed.tool,
      setSpace(on) { ed.spaceHeld = !!on; },
      setToolColor(c) { if (ed.tool === "highlighter") ed.highlighter.color = c; else if (ed.tool === "pen") ed.pen.color = c; else ed.textDefaults.color = c; applyColorToSelection(c); },
      toolColor() { return ed.tool === "highlighter" ? ed.highlighter.color : ed.tool === "pen" ? ed.pen.color : ed.textDefaults.color; },
      // Unified active colour: one colour used by pen, highlighter and text.
      setActiveColor(c) { ed.pen.color = c; ed.highlighter.color = c; ed.textDefaults.color = c; applyColorToSelection(c); },
      activeColor() { return ed.pen.color; },
      setToolSize(s) { if (ed.tool === "highlighter") ed.highlighter.size = s; else ed.pen.size = s; },
      toolSize() { return ed.tool === "highlighter" ? ed.highlighter.size : ed.pen.size; },
      setSizes(s) { if (s && s.pen != null) ed.pen.size = s.pen; if (s && s.highlighter != null) ed.highlighter.size = s.highlighter; },
      applyColor(c) { return applyColorToSelection(c); },
      setTextProp, setCodeLanguage, setStickyColor, selectionInfo,
      isEditingRich, richCommand, selectedText, looksLikeUrl,
      linkContext, applyLink, removeLink, refocusText,
      setMarkerStyle(scale, color) { const o = curEditingObj() || (ed.sel && ed.sel.ids.length === 1 ? selObjects()[0] : null); if (!o || o.type !== "text") return; snapshot(); if (scale != null) o.markerScale = scale; if (color !== undefined) o.markerColor = color; render(); if (opts.onChange) opts.onChange(); },
      markerInfo() { const o = curEditingObj() || (ed.sel && ed.sel.ids.length === 1 ? selObjects()[0] : null); return (o && o.type === "text") ? { scale: o.markerScale || 1, color: o.markerColor || null } : { scale: 1, color: null }; },
      zoomIn() { zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.2); }, zoomOut() { zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1 / 1.2); }, fitWidth,
      deleteSelection, rotateSelection, bringToFront() { reorderSelection(true); }, sendToBack() { reorderSelection(false); },
      stepForward() { stepSelection(1); }, stepBackward() { stepSelection(-1); },
      copySelection, pasteClipboard, hasClipboard,
      screenAt: (i, lx, ly) => l2s(i, lx, ly),
      selectionCount() { return ed.sel ? ed.sel.ids.length : 0; }, hasSelection() { return !!ed.sel; },
      undo, redo, canUndo, canRedo,
      isDirty() { return ed.dirty; }, clearDirty() { ed.dirty = false; },
      editSelectedText() { if (ed.sel && ed.sel.ids.length === 1) { const o = selObjects()[0]; if (o && (o.type === "text" || o.type === "code" || o.type === "sticky")) editText(ed.sel.pageIndex, o.id); } },
    };
  }
  return { create };
})();
