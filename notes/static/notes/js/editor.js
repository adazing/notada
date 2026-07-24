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
      p.objects.forEach((o) => { if (c === ctx && editingRef && o.id === editingRef.id && (o.type === "text" || o.type === "code")) return; drawObject(c, o); });
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
        c.save(); c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = o.color; c.lineWidth = o.size; c.globalAlpha = o.mode === "highlighter" ? 0.3 : 1;
        if (pts.length === 1) { c.fillStyle = o.color; c.beginPath(); c.arc(pts[0][0], pts[0][1], Math.max(0.5, o.size / 2), 0, Math.PI * 2); c.fill(); }
        else if (pts.length === 2) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); c.stroke(); }
        else { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); } c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); c.stroke(); }
        c.restore();
      } else if (o.type === "image") {
        const r = getImage(o.src); c.save(); c.translate(o.x + o.w / 2, o.y + o.h / 2); c.rotate(o.rotation || 0);
        if (r.loaded) c.drawImage(r.img, -o.w / 2, -o.h / 2, o.w, o.h); else { c.fillStyle = "#eee"; c.fillRect(-o.w / 2, -o.h / 2, o.w, o.h); } c.restore();
      } else if (o.type === "text") {
        const empty = !(o.text || "").trim(), th = textHeight(o), lh = o.fontSize * 1.3, al = o.align || "left";
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
    function textHeight(o) { return Math.max(o.fontSize * 1.3, wrapText(ctx, o).length * o.fontSize * 1.3) + 4; }

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
      if (o.type === "chart" || o.type === "image") return { x: o.x, y: o.y, w: o.w, h: o.h };
      let a = Infinity, b = Infinity, e = -Infinity, f = -Infinity; o.points.forEach(([x, y]) => { a = Math.min(a, x); b = Math.min(b, y); e = Math.max(e, x); f = Math.max(f, y); }); const pad = (o.size || 2) / 2;
      return { x: a - pad, y: b - pad, w: (e - a) + 2 * pad, h: (f - b) + 2 * pad };
    }
    function objAABB(o) { const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cs = [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2]].map(([dx, dy]) => { const p = rot(dx, dy, r); return [cx + p.x, cy + p.y]; }); const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]); return { x: Math.min(...xs), y: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }; }

    function selObjects() { if (!ed.sel) return []; const objs = ed.doc.pages[ed.sel.pageIndex].objects; return ed.sel.ids.map((id) => objs.find((x) => x.id === id)).filter(Boolean); }
    function drawSelection(c) {
      if (!ed.sel) return; const pi = ed.sel.pageIndex, objs = selObjects();
      c.save(); c.strokeStyle = "#5b7cfa"; c.lineWidth = 1.5;
      objs.forEach((o) => { const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(pi, cx + p.x, cy + p.y); }; const tl = cn(-b.w / 2, -b.h / 2), tr = cn(b.w / 2, -b.h / 2), br = cn(b.w / 2, b.h / 2), bl = cn(-b.w / 2, b.h / 2); c.beginPath(); c.moveTo(tl.x, tl.y); c.lineTo(tr.x, tr.y); c.lineTo(br.x, br.y); c.lineTo(bl.x, bl.y); c.closePath(); c.stroke(); });
      if (objs.length === 1) { const o = objs[0], b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(pi, cx + p.x, cy + p.y); }; const br = cn(b.w / 2, b.h / 2), tm = cn(0, -b.h / 2), rh = cn(0, -b.h / 2 - 26 / ed.view.scale); c.beginPath(); c.moveTo(tm.x, tm.y); c.lineTo(rh.x, rh.y); c.stroke(); dot(c, rh, "#5b7cfa"); dot(c, br, "#fff", "#5b7cfa"); }
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
      if (o.type === "stroke") { const tol = Math.max(6, o.size); for (let i = 0; i < o.points.length - 1; i++) if (distToSeg(lx, ly, o.points[i], o.points[i + 1]) <= tol) return true; if (o.points.length === 1) return Math.hypot(lx - o.points[0][0], ly - o.points[0][1]) <= tol; return false; }
      const p = rot(lx - cx, ly - cy, -(o.rotation || 0)); return Math.abs(p.x) <= b.w / 2 + 2 && Math.abs(p.y) <= b.h / 2 + 2;
    }
    function distToSeg(px, py, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1; let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)); }
    function topObjectAt(pi, lx, ly) { const objs = ed.doc.pages[pi].objects; for (let i = objs.length - 1; i >= 0; i--) if (pointInObject(objs[i], lx, ly)) return objs[i]; return null; }
    function handleAt(sx, sy) { if (!ed.sel || ed.sel.ids.length !== 1) return null; const o = selObjects()[0]; if (!o) return null; const b = objBox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rotation || 0; const cn = (dx, dy) => { const p = rot(dx, dy, r); return l2s(ed.sel.pageIndex, cx + p.x, cy + p.y); }; const br = cn(b.w / 2, b.h / 2), rh = cn(0, -b.h / 2 - 26 / ed.view.scale); if (Math.hypot(sx - br.x, sy - br.y) <= 12) return "resize"; if (Math.hypot(sx - rh.x, sy - rh.y) <= 12) return "rotate"; return null; }
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
    canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, getPos(e)); if (pointers.size === 2) { beginGesture(); cancelSingle(); return; } if (pointers.size > 2) return; beginSingle(getPos(e), e); });
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
      } else { setSelection(null, null); action = { type: "marquee", startPage: pl.index, start: pos }; }
    }
    function beginHandle(kind, pos) { snapshot(); const pi = ed.sel.pageIndex, o = selObjects()[0], b = objBox(o); const cs = l2s(pi, b.x + b.w / 2, b.y + b.h / 2); action = { type: kind, pageIndex: pi, id: o.id, center: cs, orig: clone(o), startAng: Math.atan2(pos.y - cs.y, pos.x - cs.x), startDist: Math.hypot(pos.x - cs.x, pos.y - cs.y) }; }

    function moveSingle(pos, e) {
      if (!action) return;
      if (action.type === "pan") { ed.view.panX += pos.x - action.last.x; ed.view.panY += pos.y - action.last.y; action.last = pos; render(); return; }
      if (action.type === "draw") { const p = ed.doc.pages[action.pageIndex], top = ed._pageTops[action.pageIndex]; const evs = (e && e.getCoalescedEvents) ? e.getCoalescedEvents() : null; const pushPt = (px, py) => { const d = s2d(px, py); action.stroke.points.push([d.x - pageLeft(p), d.y - top]); }; if (evs && evs.length) { const r = canvas.getBoundingClientRect(); evs.forEach((ev) => pushPt(ev.clientX - r.left, ev.clientY - r.top)); } else pushPt(pos.x, pos.y); render(); return; }
      if (action.type === "erase") { const d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y); if (pl) eraseAt(pl); return; }
      if (action.type === "tcol") { const o = ed.doc.pages[action.pageIndex].objects.find((x) => x.id === action.id); const p = ed.doc.pages[action.pageIndex]; const lx = s2d(pos.x, pos.y).x - pageLeft(p) - o.x; tableCols(o)[action.index] = Math.max(20, lx - action.edge); render(); return; }
      if (action.type === "trow") { const o = ed.doc.pages[action.pageIndex].objects.find((x) => x.id === action.id); const ly = s2d(pos.x, pos.y).y - ed._pageTops[action.pageIndex] - o.y; tableRows(o)[action.index] = Math.max(16, ly - action.edge); render(); return; }
      if (action.type === "marquee") { ed._marquee = { x: Math.min(action.start.x, pos.x), y: Math.min(action.start.y, pos.y), w: Math.abs(pos.x - action.start.x), h: Math.abs(pos.y - action.start.y) }; render(); return; }
      if (action.type === "move") { const d = s2d(pos.x, pos.y), dx = d.x - action.start.x, dy = d.y - action.start.y, objs = ed.doc.pages[action.pageIndex].objects; action.orig.forEach((rec) => { const o = objs.find((x) => x.id === rec.id); if (!o) return; const s = rec.snap; if (o.type === "stroke") o.points = s.points.map(([x, y]) => [x + dx, y + dy]); else { o.x = s.x + dx; o.y = s.y + dy; } }); render(); return; }
      if (action.type === "resize") {
        const o = selObjects()[0], ob = action.orig;
        if (o.type === "text" || o.type === "code" || o.type === "table") {
          // width only — text wraps / the table stretches. Row count sets height.
          const p = ed.doc.pages[action.pageIndex], d = s2d(pos.x, pos.y);
          o.w = Math.max(o.type === "code" ? 120 : o.type === "table" ? 120 : 40, (d.x - pageLeft(p)) - o.x);
        } else if (o.type === "chart") {
          const p = ed.doc.pages[action.pageIndex], d = s2d(pos.x, pos.y);
          o.w = Math.max(160, (d.x - pageLeft(p)) - o.x); o.h = Math.max(120, (d.y - ed._pageTops[action.pageIndex]) - o.y);
        } else if (o.type === "image" || o.type === "math") {
          const f = Math.max(0.1, Math.hypot(pos.x - action.center.x, pos.y - action.center.y) / (action.startDist || 1));
          const bb = objBox(ob), cx = ob.x + bb.w / 2, cy = ob.y + bb.h / 2, ow = ob.w || bb.w, oh = ob.h || bb.h;
          o.w = Math.max(20, ow * f); o.h = Math.max(16, oh * f); o.x = cx - o.w / 2; o.y = cy - o.h / 2;
        }
        render(); return;
      }
      if (action.type === "rotate") { const o = selObjects()[0], ang = Math.atan2(pos.y - action.center.y, pos.x - action.center.x); o.rotation = (action.orig.rotation || 0) + (ang - action.startAng); render(); return; }
    }
    function endSingle(pos, e) {
      const a = action; action = null; if (!a) return;
      if (a.type === "tap-pagebtn") { if (Math.hypot(pos.x - a.pos.x, pos.y - a.pos.y) < 8 && opts.onPageMenu) { const b = ed._pagebtns.find((x) => x.index === a.index); opts.onPageMenu(a.index, b ? b.cx : pos.x, b ? b.cy : pos.y); } return; }
      if (a.type === "tap-hotspot") { if (Math.hypot(pos.x - a.pos.x, pos.y - a.pos.y) < 8) { snapshot(); insertBlank(a.index); } return; }
      if (a.type === "marquee") { const m = ed._marquee; ed._marquee = null; if (!m || (m.w < 4 && m.h < 4)) { render(); return; } const pi = a.startPage, p = ed.doc.pages[pi]; const tl = s2d(m.x, m.y), br = s2d(m.x + m.w, m.y + m.h); const rx1 = tl.x - pageLeft(p), ry1 = tl.y - ed._pageTops[pi], rx2 = br.x - pageLeft(p), ry2 = br.y - ed._pageTops[pi]; const hits = p.objects.filter((o) => { const bb = objAABB(o); return bb.x < rx2 && bb.x2 > rx1 && bb.y < ry2 && bb.y2 > ry1; }).map((o) => o.id); setSelection(pi, hits); return; }
      if (a.type === "draw" || a.type === "erase" || a.type === "move" || a.type === "resize" || a.type === "rotate" || a.type === "tcol" || a.type === "trow") changed();
    }
    function cancelSingle() { if (action && action.type === "draw") { const objs = ed.doc.pages[action.pageIndex].objects; const i = objs.indexOf(action.stroke); if (i >= 0) objs.splice(i, 1); if (ed.undoStack.length) ed.undoStack.pop(); } if (action && action.type === "marquee") ed._marquee = null; action = null; render(); }
    function eraseAt(pl) { const objs = ed.doc.pages[pl.index].objects; let removed = false; for (let i = objs.length - 1; i >= 0; i--) if (objs[i].type === "stroke" && pointInObject(objs[i], pl.lx, pl.ly)) { if (action && !action.snapped) { snapshot(); action.snapped = true; } objs.splice(i, 1); removed = true; } if (removed) changed(); }

    canvas.addEventListener("wheel", (e) => { e.preventDefault(); const pos = getPos(e); if (e.ctrlKey || e.metaKey) zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * 0.0015)); else { ed.view.panX -= e.deltaX; ed.view.panY -= e.deltaY; render(); } }, { passive: false });

    // Double-click a box to edit it: text/code/sticky open inline; table/chart open a dialog.
    canvas.addEventListener("dblclick", (e) => {
      const pos = getPos(e), d = s2d(pos.x, pos.y), pl = docToPageLocal(d.x, d.y); if (!pl) return;
      const o = topObjectAt(pl.index, pl.lx, pl.ly); if (!o) return;
      setSelection(pl.index, [o.id]);
      if (o.type === "text" || o.type === "code" || o.type === "sticky") editText(pl.index, o.id);
      else if ((o.type === "table" || o.type === "chart" || o.type === "math") && opts.onEditObject) opts.onEditObject(o.type);
    });

    // ---- text overlay ----------------------------------------------------
    let editingEl = null, editingRef = null;
    function editText(pageIndex, id) {
      commitText(); const o = ed.doc.pages[pageIndex].objects.find((x) => x.id === id); if (!o) return;
      const ta = document.createElement("textarea"); ta.className = "text-overlay"; ta.value = o.text || ""; ta.spellcheck = (o.type === "text");
      positionOverlay(ta, pageIndex, o);
      ta.addEventListener("input", () => { o.text = ta.value; positionOverlay(ta, pageIndex, o); render(); if (opts.onChange) opts.onChange(); });
      ta.addEventListener("blur", commitText);
      ta.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      ta.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ta.blur(); } });
      wrap.appendChild(ta); editingEl = ta; editingRef = { pageIndex, id }; setTimeout(() => ta.focus(), 0);
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
      else { ta.style.fontFamily = (o.family || "system-ui"); ta.style.fontSize = (o.fontSize * scale) + "px"; ta.style.color = o.color; ta.style.fontWeight = o.bold ? "700" : "400"; ta.style.fontStyle = o.italic ? "italic" : "normal"; ta.style.background = "transparent"; ta.style.padding = "2px"; ta.style.textAlign = o.align || "left"; }
    }
    function commitText() {
      if (!editingEl) return; const ref = editingRef, el = editingEl; editingEl = null; editingRef = null;
      el.remove();
      // Empty boxes are kept on purpose (so you can size them before typing and
      // re-open them later); a faint placeholder keeps them visible. Delete with Del.
      changed();
    }

    // ---- pages -----------------------------------------------------------
    function ensureDefaults() { if (!ed.doc.defaults) ed.doc.defaults = { pageColor: "#ffffff", ruled: false }; ed.doc.pages.forEach((p) => { p.objects = p.objects || []; if (p.bgColor === undefined) p.bgColor = "#ffffff"; if (p.ruled === undefined) p.ruled = false; }); }
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
    function addTable() {
      snapshot(); const pageIndex = currentPageIndex(), p = ed.doc.pages[pageIndex];
      const o = { id: uid(), type: "table", x: p.width * 0.12, y: newVisiblePos(pageIndex), w: p.width * 0.76, rotation: 0, rows: 3, cols: 3, headerRow: true, headerFill: "#eef1ff", altFill: null, gridColor: "#c9cede", textColor: "#1a1a1a", fontSize: 14, align: "left", data: [["Column 1", "Column 2", "Column 3"], ["", "", ""], ["", "", ""]] };
      p.objects.push(o); ed.tool = "select"; if (opts.onToolChange) opts.onToolChange("select"); setSelection(pageIndex, [o.id]); changed(); return o.id;
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
    function deleteSelection() { if (!ed.sel) return; snapshot(); const page = ed.doc.pages[ed.sel.pageIndex], ids = new Set(ed.sel.ids); page.objects = page.objects.filter((o) => !ids.has(o.id)); setSelection(null, null); changed(); }
    function applyColorToSelection(color) { if (!ed.sel) return false; let touched = false; snapshot(); selObjects().forEach((o) => { if (o.type === "stroke" || o.type === "text" || o.type === "sticky") { o.color = color; touched = true; } }); if (touched) changed(); else ed.undoStack.pop(); return touched; }
    function setTextProp(prop, value) { if (prop !== "highlight") ed.textDefaults[prop] = value; if (ed.sel) { let touched = false; snapshot(); selObjects().forEach((o) => { if (o.type === "text" && ["fontSize", "color", "bold", "italic", "family", "highlight", "align", "strike", "underline"].includes(prop)) { o[prop] = value; touched = true; } }); if (!touched) ed.undoStack.pop(); else changed(); } }
    function getSelected() { if (!ed.sel || ed.sel.ids.length !== 1) return null; const o = selObjects()[0]; return o ? clone(o) : null; }
    function updateSelected(patch) { if (!ed.sel || ed.sel.ids.length !== 1) return; const o = selObjects()[0]; if (!o) return; snapshot(); Object.assign(o, patch); changed(); }
    function setStickyColor(color) { if (!ed.sel) return; let t = false; snapshot(); selObjects().forEach((o) => { if (o.type === "sticky") { o.color = color; t = true; } }); if (t) changed(); else ed.undoStack.pop(); }
    function setCodeLanguage(lang) { ed.codeDefaults.language = lang; if (ed.sel) { let t = false; snapshot(); selObjects().forEach((o) => { if (o.type === "code") { o.language = lang; t = true; } }); if (t) changed(); else ed.undoStack.pop(); } }
    function rotateSelection() { if (!ed.sel) return; const objs = selObjects(); if (!objs.length) return; snapshot(); let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; objs.forEach((o) => { const bb = objAABB(o); x1 = Math.min(x1, bb.x); y1 = Math.min(y1, bb.y); x2 = Math.max(x2, bb.x2); y2 = Math.max(y2, bb.y2); }); const px = (x1 + x2) / 2, py = (y1 + y2) / 2, a = Math.PI / 2; objs.forEach((o) => { if (o.type === "stroke") o.points = o.points.map(([x, y]) => { const r = rot(x - px, y - py, a); return [r.x + px, r.y + py]; }); else { const b = objBox(o), cx = o.x + b.w / 2, cy = o.y + b.h / 2, r = rot(cx - px, cy - py, a); o.rotation = (o.rotation || 0) + a; o.x = (r.x + px) - b.w / 2; o.y = (r.y + py) - b.h / 2; } }); changed(); }
    function reorderSelection(toFront) { if (!ed.sel) return; snapshot(); const page = ed.doc.pages[ed.sel.pageIndex], ids = new Set(ed.sel.ids); const picked = page.objects.filter((o) => ids.has(o.id)), rest = page.objects.filter((o) => !ids.has(o.id)); page.objects = toFront ? [...rest, ...picked] : [...picked, ...rest]; changed(); }
    function selectionInfo() { const objs = selObjects(); const types = new Set(objs.map((o) => o.type)); const info = { count: objs.length, types: [...types] }; if (objs.length === 1) { const o = objs[0]; info.obj = { type: o.type, fontSize: o.fontSize, color: o.color, bold: o.bold, italic: o.italic, family: o.family, language: o.language, highlight: o.highlight }; } return info; }

    // ---- export ----------------------------------------------------------
    async function exportPdfBlob() {
      await preloadAll(); const { jsPDF } = window.jspdf; let pdf = null; const PXPT = 72 / 96;
      for (let i = 0; i < ed.doc.pages.length; i++) {
        const p = ed.doc.pages[i], wpt = p.width * PXPT, hpt = p.height * PXPT, orient = wpt > hpt ? "l" : "p";
        if (i === 0) pdf = new jsPDF({ unit: "pt", format: [wpt, hpt], orientation: orient }); else pdf.addPage([wpt, hpt], orient);
        if (p.background && p.objects.length === 0 && (p.bgColor === "#ffffff" || !p.bgColor)) pdf.addImage(p.background, "JPEG", 0, 0, wpt, hpt);
        else { const sf = 2, oc = document.createElement("canvas"); oc.width = Math.round(p.width * sf); oc.height = Math.round(p.height * sf); const c = oc.getContext("2d"); c.scale(sf, sf); drawPageContents(c, p); pdf.addImage(oc.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, wpt, hpt); }
        await new Promise((r) => setTimeout(r));
      }
      return pdf ? pdf.output("blob") : null;
    }

    // ---- public ----------------------------------------------------------
    function loadDoc(doc) { commitText(); ed.doc = doc && doc.pages && doc.pages.length ? doc : { pages: [newBlankPage()], defaults: { pageColor: "#ffffff", ruled: false } }; ensureDefaults(); ed.sel = null; ed.dirty = false; ed.undoStack.length = 0; ed.redoStack.length = 0; fitWidth(); ed._needFit = wrap.clientWidth < 50; layout(); render(); if (opts.onPages) opts.onPages(ed.doc.pages.length, currentPageIndex() + 1); if (opts.onSelect) opts.onSelect(0); if (opts.onHistory) opts.onHistory(false, false); }
    function getColors() { return { pen: ed.pen.color, highlighter: ed.highlighter.color, text: ed.textDefaults.color }; }
    function setColors(c) { if (!c) return; if (c.pen) ed.pen.color = c.pen; if (c.highlighter) ed.highlighter.color = c.highlighter; if (c.text) ed.textDefaults.color = c.text; }
    function getDoc() { if (editingEl && editingRef) { const o = ed.doc.pages[editingRef.pageIndex] && ed.doc.pages[editingRef.pageIndex].objects.find((x) => x.id === editingRef.id); if (o) o.text = editingEl.value; } return ed.doc; }

    const ro = new ResizeObserver(() => { if (ed._needFit && wrap.clientWidth >= 50) { ed._needFit = false; fitWidth(); } render(); }); ro.observe(wrap);

    return {
      loadDoc, getDoc, exportPdfBlob, importPdf, addImageFromFile, addCode, addSticky, addTable, addChart, addMath,
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
      applyColor(c) { return applyColorToSelection(c); },
      setTextProp, setCodeLanguage, setStickyColor, selectionInfo,
      zoomIn() { zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.2); }, zoomOut() { zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1 / 1.2); }, fitWidth,
      deleteSelection, rotateSelection, bringToFront() { reorderSelection(true); }, sendToBack() { reorderSelection(false); },
      selectionCount() { return ed.sel ? ed.sel.ids.length : 0; }, hasSelection() { return !!ed.sel; },
      undo, redo, canUndo, canRedo,
      isDirty() { return ed.dirty; }, clearDirty() { ed.dirty = false; },
      editSelectedText() { if (ed.sel && ed.sel.ids.length === 1) { const o = selObjects()[0]; if (o && (o.type === "text" || o.type === "code" || o.type === "sticky")) editText(ed.sel.pageIndex, o.id); } },
    };
  }
  return { create };
})();
