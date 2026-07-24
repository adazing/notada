/* Notada front-end shell: library (folders + notes) and editor glue. */
(() => {
  "use strict";
  const CSRF = document.querySelector('meta[name="csrf-token"]').content;
  const $ = (s) => document.querySelector(s);

  async function api(url, method = "GET", body = null) {
    const opts = { method, headers: { "X-CSRFToken": CSRF, "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  const DEFAULT_PALETTE = ["#1a1a1a", "#e4576b", "#f5a623", "#2ca24c", "#4078f2", "#9b51e0"];
  const state = {
    folders: [], expanded: new Set(JSON.parse(localStorage.getItem("nd_expanded") || "[]")),
    currentFolderId: null, notes: [], currentNote: null, search: "",
    docTimer: null, pdfTimer: null, pendingImport: null, pageMenuIndex: 0,
    view: "library", selectedNotes: new Set(), lastNoteIdx: -1,
    palette: JSON.parse(localStorage.getItem("nd_palette") || "null") || DEFAULT_PALETTE.slice(),
    activeIdx: Math.max(0, parseInt(localStorage.getItem("nd_active") || "0", 10) || 0),
    appUndo: [],
  };
  let editor = null, suppressDocClick = false;

  function toast(msg, actionLabel, actionFn) {
    const t = $("#toast"); t.innerHTML = "";
    t.append(document.createTextNode(msg));
    if (actionLabel) { const b = document.createElement("button"); b.textContent = actionLabel; b.className = "toast-action"; b.onclick = () => { t.hidden = true; actionFn(); }; t.append(b); }
    t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), actionLabel ? 5000 : 1800);
  }
  function busy(on, text) { $("#busy").hidden = !on; if (text) $("#busy-text").textContent = text; }
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function fmtDate(iso) { const d = new Date(iso), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); }
  function flatten(list, depth, out) { out = out || []; (list || []).forEach((f) => { out.push({ id: f.id, name: f.name, depth }); flatten(f.children, depth + 1, out); }); return out; }

  // app-level undo (moves / deletes) ---------------------------------------
  function pushAppUndo(label, fn) { state.appUndo.push({ label, fn }); if (state.appUndo.length > 30) state.appUndo.shift(); }
  async function appUndoPop() { const a = state.appUndo.pop(); if (!a) { toast("Nothing to undo"); return; } await a.fn(); toast("Undone: " + a.label); }

  // ========================= FOLDERS =========================
  async function loadFolders() { const d = await api("/api/folders/"); state.folders = d.folders; renderTree(); }
  function renderTree() {
    const tree = $("#folder-tree"); tree.innerHTML = "";
    if (!state.folders.length) { tree.innerHTML = '<p class="empty-list">No folders yet.<br>Click “＋ Folder”.</p>'; return; }
    state.folders.forEach((f) => tree.appendChild(folderNode(f)));
  }
  function folderNode(folder) {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "folder-row" + (state.currentFolderId === folder.id ? " active" : "");
    row.draggable = true;
    const hasKids = folder.children && folder.children.length, isOpen = state.expanded.has(folder.id);
    row.innerHTML = `<span class="twist">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span><span class="dot" style="background:${folder.color}"></span><span class="fname">${esc(folder.name)}</span><span class="count">${folder.note_count || ""}</span><span class="row-actions"><button data-act="add" title="New subfolder">＋</button><button data-act="rename" title="Rename">✎</button><button data-act="color" title="Colour">🎨</button><button data-act="delete" title="Delete">🗑</button></span>`;
    row.querySelector(".twist").onclick = (e) => { e.stopPropagation(); if (!hasKids) return; isOpen ? state.expanded.delete(folder.id) : state.expanded.add(folder.id); localStorage.setItem("nd_expanded", JSON.stringify([...state.expanded])); renderTree(); };
    row.onclick = () => selectFolder(folder);
    row.oncontextmenu = (e) => { e.preventDefault(); showFolderMenu(e.clientX, e.clientY, folder); };
    row.querySelectorAll(".row-actions button").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); folderAction(b.dataset.act, folder); }; });
    row.addEventListener("dragstart", (e) => { e.stopPropagation(); e.dataTransfer.setData("text/folder", String(folder.id)); e.dataTransfer.effectAllowed = "move"; });
    row.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/note") || e.dataTransfer.types.includes("text/folder")) { e.preventDefault(); row.classList.add("drop-target"); } });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove("drop-target"); const nid = e.dataTransfer.getData("text/note"), fid = e.dataTransfer.getData("text/folder"); if (nid) await moveNote(+nid, folder.id); else if (fid && +fid !== folder.id) await moveFolder(+fid, folder.id); });
    wrap.appendChild(row);
    if (hasKids && isOpen) { const kids = document.createElement("div"); kids.className = "folder-children"; folder.children.forEach((c) => kids.appendChild(folderNode(c))); wrap.appendChild(kids); }
    return wrap;
  }
  async function folderAction(act, folder) {
    if (act === "add") { const n = prompt("New subfolder name:", "New folder"); if (n === null) return; await api("/api/folders/", "POST", { name: n, parent_id: folder.id }); state.expanded.add(folder.id); await loadFolders(); }
    else if (act === "rename") { const n = prompt("Rename folder:", folder.name); if (n === null || !n.trim()) return; await api(`/api/folders/${folder.id}/`, "PATCH", { name: n }); await loadFolders(); }
    else if (act === "color") { pickColor(folder.color, async (c) => { await api(`/api/folders/${folder.id}/`, "PATCH", { color: c }); await loadFolders(); }); }
    else if (act === "delete") { if (!confirm(`Delete “${folder.name}” and all notes inside it?`)) return; await api(`/api/folders/${folder.id}/`, "DELETE"); if (state.currentFolderId === folder.id) { state.currentFolderId = null; state.notes = []; renderNotes(); } await loadFolders(); }
  }
  function showFolderMenu(x, y, folder) {
    const items = [{ label: "＋ New subfolder", fn: () => folderAction("add", folder) }, { label: "✎ Rename", fn: () => folderAction("rename", folder) }, { label: "🎨 Colour", fn: () => folderAction("color", folder) }, { sep: true }, { label: "⤒ Move to top level", fn: () => moveFolder(folder.id, null) }, { label: "📁 Move into…", fn: () => chooseFolderMenu(x, y, folder.id, (fid) => moveFolder(folder.id, fid)) }, { sep: true }, { label: "🗑 Delete", danger: true, fn: () => folderAction("delete", folder) }];
    openCtx(x, y, items);
  }
  async function moveFolder(id, parentId) {
    const before = findFolderParent(state.folders, id);
    await api(`/api/folders/${id}/`, "PATCH", { parent_id: parentId });
    if (parentId) state.expanded.add(parentId);
    await loadFolders();
    pushAppUndo("move folder", async () => { await api(`/api/folders/${id}/`, "PATCH", { parent_id: before }); await loadFolders(); });
    toast("Folder moved", "Undo", () => appUndoPop());
  }
  function findFolderParent(list, id, parent) { for (const f of list || []) { if (f.id === id) return parent || null; const r = findFolderParent(f.children, id, f.id); if (r !== undefined) return r; } return undefined; }

  async function selectFolder(folder) { state.currentFolderId = folder.id; state.search = ""; $("#search").value = ""; $("#current-folder-name").textContent = folder.name; clearNoteSel(); renderTree(); await loadNotes(); }

  async function moveNote(noteId, folderId) {
    const before = (state.notes.find((n) => n.id === noteId) || {}).folder_id || (state.currentNote && state.currentNote.id === noteId ? state.currentNote.folder_id : null);
    await api(`/api/notes/${noteId}/`, "PATCH", { folder_id: folderId });
    await loadNotes(); await loadFolders();
    if (before) { pushAppUndo("move note", async () => { await api(`/api/notes/${noteId}/`, "PATCH", { folder_id: before }); await loadNotes(); await loadFolders(); }); toast("Note moved", "Undo", () => appUndoPop()); }
  }

  // ========================= NOTE LIST =========================
  async function loadNotes() {
    let url = "/api/notes/?"; if (state.search) url += "q=" + encodeURIComponent(state.search); else if (state.currentFolderId) url += "folder=" + state.currentFolderId;
    const sortEl = document.getElementById("note-sort"); url += "&sort=" + encodeURIComponent(sortEl ? sortEl.value : "-updated");
    const d = await api(url); state.notes = d.notes; renderNotes();
  }
  function renderNotes() {
    const list = $("#note-list"); list.innerHTML = "";
    if (!state.notes.length) { list.innerHTML = '<p class="empty-list">No notes here yet.<br>Create one, or import a PDF.</p>'; return; }
    state.notes.forEach((n, idx) => {
      const card = document.createElement("div");
      card.className = "note-card" + (state.currentNote && state.currentNote.id === n.id ? " active" : "") + (state.selectedNotes.has(n.id) ? " msel" : "");
      card.style.borderLeftColor = n.color || "var(--accent)"; card.draggable = true;
      card.innerHTML = `<div class="nc-title">${n.pinned ? "📌 " : ""}${esc(n.title)}</div><div class="nc-meta"><span class="badge">${n.pages} pg</span><span>${fmtDate(n.updated)}</span></div>`;
      card.onclick = (e) => {
        if (e.metaKey || e.ctrlKey) { toggleNoteSel(n.id); state.lastNoteIdx = idx; }
        else if (e.shiftKey && state.lastNoteIdx >= 0) { const a = Math.min(state.lastNoteIdx, idx), b = Math.max(state.lastNoteIdx, idx); for (let i = a; i <= b; i++) state.selectedNotes.add(state.notes[i].id); renderNotes(); updateBulkBar(); }
        else { clearNoteSel(); state.lastNoteIdx = idx; openNote(n.id); }
      };
      card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/note", String(n.id)); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.oncontextmenu = (e) => { e.preventDefault(); showNoteMenu(e.clientX, e.clientY, n); };
      list.appendChild(card);
    });
  }
  function toggleNoteSel(id) { state.selectedNotes.has(id) ? state.selectedNotes.delete(id) : state.selectedNotes.add(id); renderNotes(); updateBulkBar(); }
  function clearNoteSel() { state.selectedNotes.clear(); updateBulkBar(); }
  function updateBulkBar() { const c = state.selectedNotes.size; $("#bulk-bar").hidden = !c; $("#bulk-count").textContent = `${c} selected`; renderNotes(); }

  function showNoteMenu(x, y, note) {
    const items = [{ label: "Open", fn: () => openNote(note.id) }, { label: "📁 Move to…", fn: () => chooseFolderMenu(x, y, null, (fid) => moveNote(note.id, fid), note.folder_id) }, { label: note.pinned ? "Unpin" : "📌 Pin", fn: async () => { await api(`/api/notes/${note.id}/`, "PATCH", { pinned: !note.pinned }); await loadNotes(); } }, { sep: true }, { label: "🗑 Delete note", danger: true, fn: () => deleteNote(note) }];
    openCtx(x, y, items);
  }

  // ========================= CONTEXT MENU HELPERS =========================
  function openCtx(x, y, items) {
    const menu = $("#ctx-menu"); menu.innerHTML = "";
    items.forEach((it) => { if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; menu.append(s); return; } if (it.header) { const h = document.createElement("div"); h.className = "ctx-label"; h.textContent = it.header; menu.append(h); return; } const b = document.createElement("button"); b.innerHTML = it.label; if (it.danger) b.className = "danger-item"; b.onclick = () => { hideCtx(); it.fn(); }; menu.append(b); });
    menu.hidden = false; menu.style.left = Math.min(x, window.innerWidth - 220) + "px"; menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + "px";
  }
  function hideCtx() { $("#ctx-menu").hidden = true; }
  function chooseFolderMenu(x, y, excludeId, cb, alsoExclude) {
    const items = [{ header: "Move to" }];
    flatten(state.folders, 0).forEach((f) => { if (f.id === excludeId || f.id === alsoExclude) return; items.push({ label: "&nbsp;".repeat(f.depth * 2) + "📁 " + esc(f.name), fn: () => cb(f.id) }); });
    if (items.length === 1) items.push({ label: "(no other folders)", fn: () => {} });
    openCtx(x, y, items);
  }

  // ========================= EDITOR / NOTE =========================
  function setView(v) { state.view = v; $("#app").classList.toggle("view-editor", v === "editor"); $("#app").classList.toggle("view-library", v === "library"); }
  async function createNote() {
    if (!state.currentFolderId) { toast("Pick or create a folder first"); return null; }
    const note = await api("/api/notes/", "POST", { folder_id: state.currentFolderId }); await loadNotes(); await loadFolders(); openNoteObject(note); $("#note-title").focus(); $("#note-title").select(); return note;
  }
  async function openNote(id) { await flushSave(); const note = await api(`/api/notes/${id}/`); openNoteObject(note); }
  function openNoteObject(note) { state.currentNote = note; setView("editor"); $("#editor-pane").classList.remove("empty"); $("#editor").hidden = false; $("#note-title").value = note.title; editor.loadDoc(note.doc); setStatus("saved"); renderNotes(); syncPalette(); updateOptionPanels(); }
  function closeEditor() { state.currentNote = null; $("#editor-pane").classList.add("empty"); $("#editor").hidden = true; }
  async function backToLibrary() { await flushSave(); closeEditor(); setView("library"); renderNotes(); }
  async function deleteNote(note) {
    if (!confirm(`Delete “${note.title}”?`)) return;
    const full = await api(`/api/notes/${note.id}/`); // grab doc for undo
    await api(`/api/notes/${note.id}/`, "DELETE");
    if (state.currentNote && state.currentNote.id === note.id) { closeEditor(); setView("library"); }
    await loadNotes(); await loadFolders();
    pushAppUndo("delete note", async () => { await recreateNote(full); await loadNotes(); await loadFolders(); });
    toast("Note deleted", "Undo", () => appUndoPop());
  }
  async function recreateNote(data) { const n = await api("/api/notes/", "POST", { folder_id: data.folder_id, title: data.title, color: data.color }); await api(`/api/notes/${n.id}/`, "PATCH", { doc: data.doc, pinned: data.pinned }); return n; }

  function setStatus(kind) { const el = $("#save-status"); el.className = "save-status " + (kind === "saving" ? "saving" : kind === "saved" ? "saved" : kind === "error" ? "error" : ""); el.textContent = kind === "saving" ? "Saving…" : kind === "error" ? "⚠ Save failed" : "Saved"; }
  function scheduleSave() { if (!state.currentNote) return; setStatus("saving"); clearTimeout(state.docTimer); state.docTimer = setTimeout(saveDoc, 600); clearTimeout(state.pdfTimer); state.pdfTimer = setTimeout(savePdf, 2500); }
  async function saveDoc() { const n = state.currentNote; if (!n) return; try { const u = await api(`/api/notes/${n.id}/`, "PATCH", { title: $("#note-title").value || "Untitled note", doc: editor.getDoc() }); Object.assign(n, { title: u.title, pages: u.pages }); editor.clearDirty(); setStatus("saved"); const i = state.notes.findIndex((x) => x.id === n.id); if (i >= 0) { Object.assign(state.notes[i], { title: u.title, pages: u.pages }); renderNotes(); } } catch (e) { setStatus("error"); } }
  let pdfBusy = false;
  async function savePdf() { const n = state.currentNote; if (!n || pdfBusy) return; pdfBusy = true; try { const blob = await editor.exportPdfBlob(); if (blob) await fetch(`/api/notes/${n.id}/pdf/`, { method: "POST", headers: { "X-CSRFToken": CSRF, "Content-Type": "application/pdf" }, body: blob }); } catch (e) {} finally { pdfBusy = false; } }
  async function flushSave() { if (!state.currentNote) return; clearTimeout(state.docTimer); clearTimeout(state.pdfTimer); if (editor.isDirty()) { await saveDoc(); await savePdf(); } }

  // ========================= COLOUR / PALETTE =========================
  let colorCb = null;
  const hiddenColor = document.createElement("input"); hiddenColor.type = "color"; hiddenColor.style.display = "none"; document.body.appendChild(hiddenColor);
  hiddenColor.onchange = () => colorCb && colorCb(hiddenColor.value);
  function pickColor(cur, cb) { colorCb = cb; hiddenColor.value = cur || "#6c8cff"; hiddenColor.click(); }

  // Colour modes: the palette is a row of colour "modes", exactly one selected.
  // The selected mode's colour is THE drawing colour (pen / text / highlighter).
  // The picker edits the selected mode, saved across every note until changed.
  function renderPalette() {
    const box = $("#palette"); box.innerHTML = "";
    state.palette.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "pal" + (i === state.activeIdx ? " selected" : "");
      b.style.background = c; b.title = c + " — click to select this colour mode";
      b.onclick = () => selectColorMode(i);
      box.append(b);
    });
  }
  function saveColorState() { localStorage.setItem("nd_palette", JSON.stringify(state.palette)); localStorage.setItem("nd_active", String(state.activeIdx)); }
  function applyActiveColor() { const c = state.palette[state.activeIdx] || "#1a1a1a"; editor.setActiveColor(c); const ac = $("#active-color"); if (ac) ac.value = c; renderPalette(); }
  function selectColorMode(i) { state.activeIdx = i; applyActiveColor(); saveColorState(); }
  function setActiveModeColor(newColor) { state.palette[state.activeIdx] = newColor; applyActiveColor(); saveColorState(); }
  function syncPalette() { applyActiveColor(); }

  // ========================= OPTION PANELS =========================
  function updateOptionPanels() {
    const info = editor.selectionInfo();
    $("#sel-actions").hidden = !info.count; $("#sel-count").textContent = info.count > 1 ? `${info.count} selected` : "";
    const selType = info.count === 1 && info.obj ? info.obj.type : null;
    $("#sel-edit").hidden = !(selType === "table" || selType === "chart");
    let panel = null;
    if (selType === "text") panel = "text"; else if (selType === "code") panel = "code";
    if (!panel) { const t = editor.tool(); if (t === "pen" || t === "highlighter") panel = "pen"; else if (t === "text") panel = "text"; }
    $("#pen-opts").classList.toggle("hidden", panel !== "pen");
    $("#text-opts").hidden = panel !== "text"; $("#code-opts").hidden = panel !== "code";
    if (panel === "pen") { $("#pen-size").value = editor.toolSize(); $("#size-val").textContent = editor.toolSize(); }
    else if (panel === "text") { const o = info.obj || {}; if (o.fontSize) $("#text-size").value = Math.round(o.fontSize); if (o.family) $("#text-family").value = o.family; $("#text-bold").classList.toggle("on", !!o.bold); $("#text-italic").classList.toggle("on", !!o.italic); $("#text-underline").classList.toggle("on", !!o.underline); $("#text-strike").classList.toggle("on", !!o.strike); $("#text-hl-toggle").classList.toggle("on", !!o.highlight); if (o.highlight) $("#text-hl").value = o.highlight; const al = o.align || "left"; document.querySelectorAll("#text-align button").forEach((b) => b.classList.toggle("on", b.dataset.align === al)); }
    else if (panel === "code") { const o = info.obj || {}; if (o.language) $("#code-lang").value = o.language; }
  }

  // ========================= MODAL =========================
  function openModal(title, bodyHTML, onOk) { $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHTML; $("#modal").hidden = false; const ok = $("#modal-ok"), cancel = $("#modal-cancel"); const close = () => { $("#modal").hidden = true; }; ok.onclick = () => { if (onOk($("#modal-body")) !== false) close(); }; cancel.onclick = close; return close; }
  const PRESETS = { "A4 portrait": [794, 1123], "A4 landscape": [1123, 794], "Letter portrait": [816, 1056], "Letter landscape": [1056, 816], "Square": [900, 900] };
  function sizeBody(w, h, withPos) {
    let opt = Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join("") + "<option>Custom</option>";
    let html = `<div class="modal-row"><label>Preset</label><select id="m-preset">${opt}</select></div><div class="modal-row dims"><label>Width</label><input id="m-w" type="number" min="100" max="5000" value="${w}"><label style="flex:0 0 auto">Height</label><input id="m-h" type="number" min="100" max="5000" value="${h}"></div>`;
    if (withPos) html += `<div class="modal-row"><label>Position</label><select id="m-pos"><option value="after">After this page</option><option value="before">Before this page</option><option value="start">At start</option><option value="end">At end</option></select></div>`;
    return html;
  }
  function wireSize() { const p = $("#m-preset"); p.onchange = () => { const s = PRESETS[p.value]; if (s) { $("#m-w").value = s[0]; $("#m-h").value = s[1]; } }; }
  function addPageDialog() { const sz = editor.pageSize() || { w: 794, h: 1123 }; openModal("Add page", sizeBody(sz.w, sz.h, true), (b) => { const w = +b.querySelector("#m-w").value, h = +b.querySelector("#m-h").value, pos = b.querySelector("#m-pos").value; if (!(w > 0 && h > 0)) return false; editor.addPage({ width: w, height: h, position: pos, index: state.pageMenuIndex + (pos === "after" ? 1 : 0) }); scheduleSave(); }); $("#m-preset").value = "Custom"; wireSize(); }
  function resizePageDialog(all) { const sz = editor.pageSize() || { w: 794, h: 1123 }; openModal(all ? "Resize all pages" : "Resize this page", sizeBody(sz.w, sz.h, false), (b) => { const w = +b.querySelector("#m-w").value, h = +b.querySelector("#m-h").value; if (!(w > 0 && h > 0)) return false; if (all) editor.resizeAllPages(w, h); else editor.resizePage(state.pageMenuIndex, w, h); scheduleSave(); }); $("#m-preset").value = "Custom"; wireSize(); }

  // ========================= TABLE / CHART EDITORS =========================
  function openTableEditor() {
    const o = editor.getSelected(); if (!o || o.type !== "table") return;
    let rows = o.rows, cols = o.cols, data = (o.data || []).map((r) => r.slice());
    const ensure = () => { for (let r = 0; r < rows; r++) { data[r] = data[r] || []; for (let c = 0; c < cols; c++) if (data[r][c] == null) data[r][c] = ""; } data.length = rows; };
    const body = () => {
      ensure();
      let grid = `<div class="modal-grid" style="grid-template-columns:repeat(${cols},1fr)">`;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid += `<input data-r="${r}" data-c="${c}" value="${(data[r][c] || "").replace(/"/g, "&quot;")}">`;
      grid += `</div>`;
      return `
        <div class="modal-row"><label>Rows</label><input id="t-rows" type="number" min="1" max="30" value="${rows}"><label style="flex:0 0 auto">Columns</label><input id="t-cols" type="number" min="1" max="12" value="${cols}"></div>
        <div class="modal-row"><label>Header row</label><input type="checkbox" id="t-header" ${o.headerRow ? "checked" : ""} style="flex:0 0 auto"> <label>shade</label><input type="color" id="t-hfill" value="${o.headerFill || "#eef1ff"}" style="flex:0 0 auto;width:40px">
          <label>Zebra</label><input type="checkbox" id="t-zebra" ${o.altFill ? "checked" : ""} style="flex:0 0 auto"><input type="color" id="t-zfill" value="${o.altFill || "#f4f6ff"}" style="flex:0 0 auto;width:40px"></div>
        <div class="modal-row"><label>Grid / text</label><input type="color" id="t-grid" value="${o.gridColor || "#c9cede"}" style="flex:0 0 auto;width:40px"><input type="color" id="t-text" value="${o.textColor || "#1a1a1a"}" style="flex:0 0 auto;width:40px">
          <label>Align</label><select id="t-align"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>
        <div style="font-size:.74rem;color:var(--muted);margin-bottom:4px">Cell contents</div>${grid}`;
    };
    const rerender = () => { $("#modal-body").innerHTML = body(); wireControls(); };
    const readGrid = () => { $("#modal-body").querySelectorAll(".modal-grid input").forEach((inp) => { data[+inp.dataset.r][+inp.dataset.c] = inp.value; }); };
    const wireControls = () => {
      $("#t-align").value = o.align || "left";
      $("#t-rows").onchange = () => { readGrid(); rows = Math.max(1, Math.min(30, +$("#t-rows").value || 1)); rerender(); };
      $("#t-cols").onchange = () => { readGrid(); cols = Math.max(1, Math.min(12, +$("#t-cols").value || 1)); rerender(); };
    };
    openModal("Edit table", body(), (b) => {
      readGrid();
      editor.updateSelected({ rows, cols, data, headerRow: b.querySelector("#t-header").checked, headerFill: b.querySelector("#t-hfill").value, altFill: b.querySelector("#t-zebra").checked ? b.querySelector("#t-zfill").value : null, gridColor: b.querySelector("#t-grid").value, textColor: b.querySelector("#t-text").value, align: b.querySelector("#t-align").value });
      scheduleSave();
    });
    wireControls();
  }

  const CHART_PAL = ["#5b7cfa", "#e4576b", "#2ca24c", "#f5a623", "#9b51e0", "#00b4c6", "#ff7a45"];
  function openChartEditor() {
    const o = editor.getSelected(); if (!o || o.type !== "chart") return;
    let type = o.chartType;
    let pts = (o.points || []).map((p) => ({ ...p }));
    let cats = (o.categories || pts.map((p) => p.label)).slice();
    let series = (o.series && o.series.length ? o.series : [{ name: "Series 1", color: CHART_PAL[0], values: pts.map((p) => p.value) }]).map((s) => ({ name: s.name, color: s.color, values: (s.values || []).slice() }));
    const esc2 = (s) => String(s == null ? "" : s).replace(/"/g, "&quot;");

    const ptsBody = () => {
      let rows = `<div class="chart-rows" id="c-rows">`;
      pts.forEach((p, i) => { rows += `<div class="chart-row"><input type="text" data-i="${i}" data-k="label" value="${esc2(p.label)}" placeholder="label"><input type="number" data-i="${i}" data-k="value" value="${p.value}"><input type="color" data-i="${i}" data-k="color" value="${p.color || CHART_PAL[i % 7]}"><button data-del="${i}">✕</button></div>`; });
      rows += `</div><button id="c-add" class="btn ghost small">＋ Add ${type === "pie" ? "slice" : "bar"}</button>`;
      return `<div style="font-size:.74rem;color:var(--muted);margin:4px 0 2px">Data</div>${rows}`;
    };
    const lineBody = () => {
      let h = `<div style="font-size:.74rem;color:var(--muted);margin:4px 0 2px">Categories (x-axis)</div><div class="chart-row" id="c-cats">`;
      cats.forEach((c, i) => { h += `<input type="text" data-ci="${i}" value="${esc2(c)}" style="flex:1">`; });
      h += `<button id="c-cat-add" title="Add category">＋</button><button id="c-cat-del" title="Remove last">✕</button></div>`;
      h += `<div style="font-size:.74rem;color:var(--muted);margin:8px 0 2px">Lines</div>`;
      series.forEach((s, si) => {
        h += `<div class="chart-row" style="flex-wrap:wrap"><input type="color" data-si="${si}" data-sk="color" value="${s.color || CHART_PAL[si % 7]}"><input type="text" data-si="${si}" data-sk="name" value="${esc2(s.name)}" placeholder="line name" style="flex:1"><button data-sdel="${si}">✕</button>`;
        cats.forEach((c, ci) => { h += `<input type="number" data-si="${si}" data-vi="${ci}" value="${s.values[ci] != null ? s.values[ci] : 0}" title="${esc2(c)}" style="width:56px">`; });
        h += `</div>`;
      });
      h += `<button id="c-line-add" class="btn ghost small">＋ Add line</button>`;
      return h;
    };
    const body = () => `
      <div class="modal-row"><label>Type</label><select id="c-type"><option value="bar">Bar</option><option value="line">Line (multi)</option><option value="pie">Pie</option></select></div>
      <div class="modal-row"><label>Title</label><input id="c-title" value="${esc2(o.title)}"></div>
      ${type === "bar" ? `<div class="modal-row"><label>Bar width</label><input id="c-bw" type="range" min="0.2" max="1" step="0.05" value="${o.barWidth || 0.66}"></div>` : ""}
      ${type === "line" ? lineBody() : ptsBody()}`;
    const readPts = () => { $("#modal-body").querySelectorAll("#c-rows .chart-row").forEach((row, i) => row.querySelectorAll("[data-k]").forEach((inp) => { const k = inp.dataset.k; pts[i][k] = k === "value" ? (+inp.value || 0) : inp.value; })); };
    const readLine = () => {
      $("#c-cats").querySelectorAll("[data-ci]").forEach((inp) => { cats[+inp.dataset.ci] = inp.value; });
      $("#modal-body").querySelectorAll("[data-sk]").forEach((inp) => { series[+inp.dataset.si][inp.dataset.sk] = inp.value; });
      $("#modal-body").querySelectorAll("[data-vi]").forEach((inp) => { series[+inp.dataset.si].values[+inp.dataset.vi] = +inp.value || 0; });
    };
    const readCur = () => { if (type === "line") readLine(); else readPts(); };
    const rerender = () => { $("#modal-body").innerHTML = body(); wire(); };
    const wire = () => {
      $("#c-type").value = type;
      $("#c-type").onchange = () => { readCur(); type = $("#c-type").value; rerender(); };
      if ($("#c-add")) $("#c-add").onclick = () => { readPts(); pts.push({ label: "New", value: 1, color: CHART_PAL[pts.length % 7] }); rerender(); };
      $("#modal-body").querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { readPts(); pts.splice(+b.dataset.del, 1); if (!pts.length) pts.push({ label: "A", value: 1, color: CHART_PAL[0] }); rerender(); });
      if ($("#c-cat-add")) $("#c-cat-add").onclick = () => { readLine(); cats.push("New"); series.forEach((s) => s.values.push(0)); rerender(); };
      if ($("#c-cat-del")) $("#c-cat-del").onclick = () => { readLine(); if (cats.length > 1) { cats.pop(); series.forEach((s) => s.values.pop()); } rerender(); };
      if ($("#c-line-add")) $("#c-line-add").onclick = () => { readLine(); series.push({ name: "Series " + (series.length + 1), color: CHART_PAL[series.length % 7], values: cats.map(() => 0) }); rerender(); };
      $("#modal-body").querySelectorAll("[data-sdel]").forEach((b) => b.onclick = () => { readLine(); series.splice(+b.dataset.sdel, 1); if (!series.length) series.push({ name: "Series 1", color: CHART_PAL[0], values: cats.map(() => 0) }); rerender(); });
    };
    openModal("Edit chart", body(), (b) => {
      readCur();
      const patch = { chartType: type, title: b.querySelector("#c-title").value };
      if (type === "bar" && b.querySelector("#c-bw")) patch.barWidth = +b.querySelector("#c-bw").value;
      if (type === "line") { patch.categories = cats; patch.series = series; } else { patch.points = pts; }
      editor.updateSelected(patch); scheduleSave();
    });
    wire();
  }

  // ========================= MATH EDITOR =========================
  function insertAtCursor(ta, text) { const s = ta.selectionStart, e = ta.selectionEnd; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); const pos = s + text.length; ta.selectionStart = ta.selectionEnd = pos; ta.focus(); ta.dispatchEvent(new Event("input")); }
  const MATH_SYMS = [["x^{2}", "xⁿ"], ["x_{n}", "xₙ"], ["\\frac{a}{b}", "a⁄b"], ["\\sqrt{x}", "√"], ["\\sqrt[n]{x}", "ⁿ√"], ["\\int_{a}^{b}", "∫"], ["\\iint", "∬"], ["\\oint", "∮"], ["\\sum_{i=1}^{n}", "∑"], ["\\prod_{i=1}^{n}", "∏"], ["\\lim_{x\\to 0}", "lim"], ["\\infty", "∞"], ["\\partial", "∂"], ["\\nabla", "∇"], ["\\pi", "π"], ["\\theta", "θ"], ["\\alpha", "α"], ["\\beta", "β"], ["\\lambda", "λ"], ["\\Delta", "Δ"], ["\\times", "×"], ["\\div", "÷"], ["\\pm", "±"], ["\\cdot", "·"], ["\\leq", "≤"], ["\\geq", "≥"], ["\\neq", "≠"], ["\\approx", "≈"], ["\\rightarrow", "→"], ["\\Rightarrow", "⇒"], ["\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "matrix"]];
  function openMathEditor() {
    const o = editor.getSelected(); if (!o || o.type !== "math") return;
    const modal = $("#math-modal"), input = $("#math-input"), preview = $("#math-preview"), sbox = $("#math-symbols");
    input.value = o.latex || "";
    sbox.innerHTML = ""; MATH_SYMS.forEach(([latex, label]) => { const b = document.createElement("button"); b.textContent = label; b.title = latex; b.onclick = () => insertAtCursor(input, latex); sbox.append(b); });
    const rerender = () => {
      const tex = input.value.trim();
      if (!tex) { preview.innerHTML = '<span class="math-hint">Preview appears here</span>'; return; }
      if (!window.MathJax || !window.MathJax.tex2svg) { preview.innerHTML = '<span class="math-hint">math engine loading… try again in a moment</span>'; return; }
      try { const node = MathJax.tex2svg(tex, { display: true }); node.querySelectorAll("mjx-assistive-mml").forEach((el) => el.remove()); preview.innerHTML = ""; preview.appendChild(node); }
      catch (e) { preview.innerHTML = '<span class="math-err">check the LaTeX…</span>'; }
    };
    input.oninput = rerender; rerender();
    modal.hidden = false; setTimeout(() => input.focus(), 0);
    const close = () => { modal.hidden = true; };
    $("#math-ok").onclick = () => { editor.setMathLatex(input.value); scheduleSave(); close(); };
    $("#math-cancel").onclick = close;
  }

  // ========================= TOOLS =========================
  function setTool(tool) { editor.setTool(tool); document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool)); updateOptionPanels(); }

  // ========================= PER-PAGE MENU =========================
  function openPageMenu(index, sx, sy) {
    state.pageMenuIndex = index; const menu = $("#page-menu"); menu.hidden = false;
    const wrapRect = $("#canvas-wrap").getBoundingClientRect();
    menu.style.left = Math.min(wrapRect.left + sx + 6, window.innerWidth - 230) + "px";
    menu.style.top = Math.min(wrapRect.top + sy + 6, window.innerHeight - menu.offsetHeight - 10) + "px";
    suppressDocClick = true;
  }

  // ========================= INIT =========================
  function init() {
    const theme = localStorage.getItem("nd_theme") || "light"; document.documentElement.dataset.theme = theme; $("#theme-btn").textContent = theme === "dark" ? "☀️" : "🌙";
    $("#theme-btn").onclick = () => { const nx = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nx; localStorage.setItem("nd_theme", nx); $("#theme-btn").textContent = nx === "dark" ? "☀️" : "🌙"; };

    editor = window.NotadaEditor.create($("#canvas-wrap"), {
      onChange: scheduleSave, onToast: toast, onBusy: busy,
      onZoom: (p) => ($("#zoom-level").textContent = p + "%"),
      onPages: (t, c) => ($("#page-info").textContent = `Page ${c} / ${t}`),
      onSelect: () => updateOptionPanels(),
      onToolChange: setTool,
      onHistory: (u, r) => { $("#undo-btn").disabled = !u; $("#redo-btn").disabled = !r; },
      onPageMenu: openPageMenu,
      onEditObject: (type) => { if (type === "table") openTableEditor(); else if (type === "chart") openChartEditor(); else if (type === "math") openMathEditor(); },
    });

    // folders / notes
    $("#new-folder-btn").onclick = async () => { const n = prompt("New folder name:", "New folder"); if (n === null) return; await api("/api/folders/", "POST", { name: n }); await loadFolders(); };
    $("#new-note-btn").onclick = createNote;
    $("#import-note-btn").onclick = async () => { if (!state.currentFolderId) { toast("Pick a folder first"); return; } await createNote(); state.pendingImport = { mode: "note" }; $("#pdf-input").click(); };
    $("#pdf-input").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; const p = state.pendingImport; state.pendingImport = null; if (!f) return; if (p && p.mode === "current") await editor.importPdf(f, p.at); else await editor.importPdf(f); scheduleSave(); };
    $("#note-title").oninput = scheduleSave;
    $("#note-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#note-title").blur(); $("#board").focus(); } });
    $("#back-btn").onclick = backToLibrary;
    $("#delete-btn").onclick = () => { if (state.currentNote) deleteNote(state.currentNote); };

    // export
    $("#export-btn").onclick = (e) => { e.stopPropagation(); $("#export-menu").hidden = !$("#export-menu").hidden; };
    $("#export-menu").querySelectorAll("button").forEach((b) => { b.onclick = async () => { const n = state.currentNote; if (!n) return; $("#export-menu").hidden = true; if (b.dataset.fmt === "json") { window.location = `/api/notes/${n.id}/export/json/`; return; } busy(true, "Preparing PDF…"); try { await flushSave(); window.location = `/api/notes/${n.id}/pdf/`; } finally { setTimeout(() => busy(false), 500); } }; });

    // undo / redo
    $("#undo-btn").onclick = () => editor.undo();
    $("#redo-btn").onclick = () => editor.redo();

    // tools
    document.querySelectorAll(".tool").forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
    $("#active-color").oninput = (e) => setActiveModeColor(e.target.value);
    $("#pen-size").oninput = (e) => { editor.setToolSize(+e.target.value); $("#size-val").textContent = e.target.value; };
    $("#add-image-btn").onclick = () => $("#image-input").click();
    $("#image-input").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) editor.addImageFromFile(f); };
    $("#add-code-btn").onclick = () => { editor.addCode(); };
    $("#add-sticky-btn").onclick = () => { editor.addSticky(); };
    $("#add-table-btn").onclick = () => { editor.addTable(); openTableEditor(); };
    $("#add-chart-btn").onclick = () => { editor.addChart(); openChartEditor(); };
    $("#add-math-btn").onclick = () => { editor.addMath(); };  // addMath triggers the math editor via onEditObject
    $("#sel-edit").onclick = () => { const info = editor.selectionInfo(); if (info.obj && info.obj.type === "table") openTableEditor(); else if (info.obj && info.obj.type === "chart") openChartEditor(); };
    document.querySelectorAll("#text-align button").forEach((b) => { b.onclick = () => editor.setTextProp("align", b.dataset.align); });

    // text options
    $("#text-size").oninput = (e) => editor.setTextProp("fontSize", +e.target.value);
    $("#text-family").onchange = (e) => editor.setTextProp("family", e.target.value);
    const tgl = (id, prop) => { $(id).onclick = () => { const on = !$(id).classList.contains("on"); $(id).classList.toggle("on", on); editor.setTextProp(prop, on); }; };
    tgl("#text-bold", "bold"); tgl("#text-italic", "italic"); tgl("#text-underline", "underline"); tgl("#text-strike", "strike");
    $("#text-hl-toggle").onclick = () => { const on = !$("#text-hl-toggle").classList.contains("on"); $("#text-hl-toggle").classList.toggle("on", on); editor.setTextProp("highlight", on ? $("#text-hl").value : null); };
    $("#text-hl").oninput = (e) => { if ($("#text-hl-toggle").classList.contains("on")) editor.setTextProp("highlight", e.target.value); };
    $("#code-lang").onchange = (e) => editor.setCodeLanguage(e.target.value);
    $("#note-sort").onchange = () => loadNotes();

    // palette
    if (state.activeIdx >= state.palette.length) state.activeIdx = 0;
    applyActiveColor();  // sets the drawing colour from the selected mode + renders palette

    // per-page menu items
    $("#page-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#page-menu").hidden = true; const i = state.pageMenuIndex, act = b.dataset.page; if (act === "add-after") { editor.addPage({ index: i + 1 }); } else if (act === "add-before") { editor.addPage({ index: i }); } else if (act === "import") { state.pendingImport = { mode: "current", at: i + 1 }; $("#pdf-input").click(); } else if (act === "resize") resizePageDialog(false); else if (act === "rotate") editor.rotatePage(i); else if (act === "bg") pickColor(editor.pageColor(i), (c) => editor.setPageBg(i, c)); else if (act === "ruled") editor.setPageRuled(i, !editor.pageRuled(i)); else if (act === "delete") { if (confirm("Delete this page?")) editor.deletePage(i); } scheduleSave(); }; });

    // all-pages menu
    $("#pages-btn").onclick = (e) => { e.stopPropagation(); $("#pages-menu").hidden = !$("#pages-menu").hidden; };
    $("#pages-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#pages-menu").hidden = true; const act = b.dataset.all; if (act === "resize") resizePageDialog(true); else if (act === "rotate") editor.rotateAllPages(); else if (act === "bg") pickColor(editor.pageColor(), (c) => editor.setAllPagesBg(c)); else if (act === "ruled-on") editor.setAllRuled(true); else if (act === "ruled-off") editor.setAllRuled(false); else if (act === "default") { const sz = editor.pageSize(); editor.setDefaults({ pageColor: editor.pageColor(), ruled: editor.pageRuled() }); toast("Saved as default for new pages"); } scheduleSave(); }; });

    // selection actions
    $("#sel-color").oninput = (e) => editor.applyColor(e.target.value);
    $("#sel-rotate").onclick = () => editor.rotateSelection();
    $("#sel-front").onclick = () => editor.bringToFront();
    $("#sel-back").onclick = () => editor.sendToBack();
    $("#sel-delete").onclick = () => editor.deleteSelection();
    // (double-click to edit is handled inside the editor — it hit-tests the box under the cursor)

    // zoom
    $("#zoom-in").onclick = () => editor.zoomIn(); $("#zoom-out").onclick = () => editor.zoomOut(); $("#zoom-level").onclick = () => editor.fitWidth();

    // bulk notes
    $("#bulk-clear").onclick = () => clearNoteSel();
    $("#bulk-delete").onclick = async () => { const ids = [...state.selectedNotes]; if (!ids.length || !confirm(`Delete ${ids.length} note(s)?`)) return; const saved = []; for (const id of ids) saved.push(await api(`/api/notes/${id}/`)); for (const id of ids) await api(`/api/notes/${id}/`, "DELETE"); clearNoteSel(); await loadNotes(); await loadFolders(); pushAppUndo("delete notes", async () => { for (const d of saved) await recreateNote(d); await loadNotes(); await loadFolders(); }); toast(`${ids.length} notes deleted`, "Undo", () => appUndoPop()); };
    $("#bulk-move").onclick = (e) => { const ids = [...state.selectedNotes]; if (!ids.length) return; const r = $("#bulk-move").getBoundingClientRect(); chooseFolderMenu(r.left, r.bottom, null, async (fid) => { for (const id of ids) await api(`/api/notes/${id}/`, "PATCH", { folder_id: fid }); clearNoteSel(); await loadNotes(); await loadFolders(); toast(`Moved ${ids.length} notes`); }); };

    // root drop zone (folders -> top level)
    const rd = $("#root-drop");
    rd.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/folder")) { e.preventDefault(); rd.classList.add("drop-target"); } });
    rd.addEventListener("dragleave", () => rd.classList.remove("drop-target"));
    rd.addEventListener("drop", async (e) => { e.preventDefault(); rd.classList.remove("drop-target"); const fid = e.dataTransfer.getData("text/folder"); if (fid) await moveFolder(+fid, null); });

    // search
    let st; $("#search").oninput = (e) => { clearTimeout(st); st = setTimeout(() => { state.search = e.target.value.trim(); loadNotes(); }, 250); };

    // close menus on outside click
    document.addEventListener("click", () => { if (suppressDocClick) { suppressDocClick = false; return; } $("#export-menu").hidden = true; $("#pages-menu").hidden = true; $("#page-menu").hidden = true; hideCtx(); });
    window.addEventListener("scroll", () => { hideCtx(); $("#page-menu").hidden = true; }, true);

    // keyboard
    document.addEventListener("keydown", (e) => {
      const ae = document.activeElement, tag = ae.tagName;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "s") { e.preventDefault(); flushSave().then(() => toast("Saved")); return; }
      // Undo/redo: while typing IN A TEXT BOX or dropdown, leave native behaviour.
      // But the note-title input hands undo back to the drawing (blur first).
      const inTextEntry = tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && ae.id !== "note-title");
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) { if (inTextEntry) return; if (ae.id === "note-title") ae.blur(); e.preventDefault(); if (state.view === "editor" && state.currentNote && editor.canUndo()) editor.undo(); else appUndoPop(); return; }
      if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) { if (inTextEntry) return; if (ae.id === "note-title") ae.blur(); e.preventDefault(); if (state.currentNote) editor.redo(); return; }
      if (typing || !state.currentNote || state.view !== "editor") return;
      if (e.key === "Delete" || e.key === "Backspace") { if (editor.hasSelection()) { e.preventDefault(); editor.deleteSelection(); } return; }
      if (e.key === " ") editor.setSpace(true);
      const map = { v: "select", p: "pen", h: "highlighter", e: "eraser", t: "text" };
      if (map[key]) setTool(map[key]);
    });
    document.addEventListener("keyup", (e) => { if (e.key === " ") editor.setSpace(false); });

    setTool("select");
    setView("library");
    loadFolders();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
