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

  // Upload an audio/video clip to disk and get back a stable URL to play it from.
  async function uploadMedia(blob, mime) {
    const type = (mime || blob.type || "application/octet-stream").split(";")[0];
    const res = await fetch("/api/media/?type=" + encodeURIComponent(type), { method: "POST", headers: { "X-CSRFToken": CSRF }, body: blob });
    if (!res.ok) throw new Error("media upload → " + res.status);
    return (await res.json()).url;
  }

  const DEFAULT_PALETTES = {
    pen: ["#1a1a1a", "#e4576b", "#f5a623", "#2ca24c", "#4078f2", "#9b51e0"],
    highlighter: ["#fff59d", "#a5f3b4", "#a0e7ff", "#ffc6d9", "#e5c6ff", "#ffd8a8"],
    text: ["#1a1a1a", "#e4576b", "#f5a623", "#2ca24c", "#4078f2", "#9b51e0"],
  };
  const clone2 = (o) => JSON.parse(JSON.stringify(o));
  const state = {
    folders: [], expanded: new Set(JSON.parse(localStorage.getItem("nd_expanded") || "[]")),
    currentFolderId: null, notes: [], currentNote: null, search: "",
    docTimer: null, pdfTimer: null, pendingImport: null, pageMenuIndex: 0,
    view: "library", selectedNotes: new Set(), lastNoteIdx: -1,
    palettes: JSON.parse(localStorage.getItem("nd_palettes") || "null") || clone2(DEFAULT_PALETTES),
    colorSel: JSON.parse(localStorage.getItem("nd_colorsel") || "null") || { pen: 0, highlighter: 0, text: 0 },
    sizes: JSON.parse(localStorage.getItem("nd_sizes") || "null") || { pen: [0.5, 1, 2, 3, 5, 8, 12, 18, 26, 40], highlighter: [8, 12, 16, 24, 34, 48] },
    sizeSel: JSON.parse(localStorage.getItem("nd_sizesel") || "null") || { pen: 3, highlighter: 2 },
    appUndo: [],
  };
  let editor = null, suppressDocClick = false;

  // rgb()/rgba() -> #rrggbb (drops alpha) so a <input type=color> can show it
  function rgbToHex(c) {
    if (!c) return null; if (c[0] === "#") return c;
    const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/); if (!m) return null;
    return "#" + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, "0")).join("");
  }

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
  let _folderDnDBound = false, _pendingDrop = null;
  function renderTree() {
    const tree = $("#folder-tree"); tree.innerHTML = "";
    if (!state.folders.length) { tree.innerHTML = '<p class="empty-list">No folders yet.<br>Click “＋ Folder”.</p>'; return; }
    state.folders.forEach((f) => tree.appendChild(folderNode(f, 0)));
    const line = document.createElement("div"); line.id = "folder-dropline"; line.hidden = true; tree.appendChild(line);
    ensureFolderDnD(tree);
  }
  function folderNode(folder, depth) {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "folder-row" + (state.currentFolderId === folder.id ? " active" : "");
    row.draggable = true; row.dataset.folderId = folder.id; row.dataset.depth = depth;
    const hasKids = folder.children && folder.children.length, isOpen = state.expanded.has(folder.id);
    row.innerHTML = `<span class="twist">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span><span class="dot" style="background:${folder.color}"></span><span class="fname">${esc(folder.name)}</span><span class="count">${folder.note_count || ""}</span><span class="row-actions"><button data-act="add" title="New subfolder">＋</button><button data-act="rename" title="Rename">✎</button><button data-act="color" title="Colour">🎨</button><button data-act="delete" title="Delete">🗑</button></span>`;
    row.querySelector(".twist").onclick = (e) => { e.stopPropagation(); if (!hasKids) return; isOpen ? state.expanded.delete(folder.id) : state.expanded.add(folder.id); localStorage.setItem("nd_expanded", JSON.stringify([...state.expanded])); renderTree(); };
    row.onclick = () => selectFolder(folder);
    row.oncontextmenu = (e) => { e.preventDefault(); showFolderMenu(e.clientX, e.clientY, folder); };
    row.querySelectorAll(".row-actions button").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); folderAction(b.dataset.act, folder); }; });
    row.addEventListener("dragstart", (e) => { e.stopPropagation(); e.dataTransfer.setData("text/folder", String(folder.id)); e.dataTransfer.effectAllowed = "move"; state._dragFolder = folder.id; });
    row.addEventListener("dragend", () => { state._dragFolder = null; hideDropline(); });
    // note drops: dropping a NOTE on a folder moves it into that folder
    row.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/note")) { e.preventDefault(); row.classList.add("drop-target"); } });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", async (e) => { if (e.dataTransfer.types.includes("text/note")) { e.preventDefault(); e.stopPropagation(); row.classList.remove("drop-target"); const nid = e.dataTransfer.getData("text/note"); if (nid) await moveNote(+nid, folder.id); } });
    wrap.appendChild(row);
    if (hasKids && isOpen) { const kids = document.createElement("div"); kids.className = "folder-children"; folder.children.forEach((c) => kids.appendChild(folderNode(c, depth + 1))); wrap.appendChild(kids); }
    return wrap;
  }
  // ---- folder drag-to-reorder with an indented drop-line ----
  function buildTreeIndex() { const map = {}; const walk = (arr, pid, chain) => arr.forEach((f) => { const c = [...chain, f.id]; map[f.id] = { parentId: pid, childrenIds: (f.children || []).map((x) => x.id), depth: chain.length, chain: c }; walk(f.children || [], f.id, c); }); walk(state.folders, null, []); return map; }
  function childrenIds(idx, pid) { return pid == null ? state.folders.map((f) => f.id) : ((idx[pid] && idx[pid].childrenIds) || []); }
  function showDropline(top, left) { const l = document.getElementById("folder-dropline"); if (l) { l.hidden = false; l.style.top = top + "px"; l.style.left = left + "px"; } }
  function hideDropline() { const l = document.getElementById("folder-dropline"); if (l) l.hidden = true; }
  const INDENT = 14;
  function computeFolderDrop(cx, cy) {
    const tree = $("#folder-tree"), treeRect = tree.getBoundingClientRect();
    const rows = [...tree.querySelectorAll(".folder-row")].map((r) => ({ id: +r.dataset.folderId, depth: +r.dataset.depth, rect: r.getBoundingClientRect() }));
    if (!rows.length) return null;
    const idx = buildTreeIndex(), dragId = state._dragFolder;
    let insertBefore = rows.length;
    for (let j = 0; j < rows.length; j++) { if (cy < rows[j].rect.top + rows[j].rect.height / 2) { insertBefore = j; break; } }
    const above = insertBefore - 1 >= 0 ? rows[insertBefore - 1] : null, below = insertBefore < rows.length ? rows[insertBefore] : null;
    let maxD = above ? above.depth + 1 : 0, minD = below ? below.depth : 0; if (maxD < minD) maxD = minD;
    const baseLeft = Math.min(...rows.map((r) => r.rect.left));
    let D = above ? Math.round((cx - baseLeft) / INDENT) : 0; D = Math.max(minD, Math.min(maxD, D));
    let parentId, orderedIds;
    if (!above) { parentId = null; orderedIds = childrenIds(idx, null).slice(); }
    else if (D === above.depth + 1) { parentId = above.id; orderedIds = childrenIds(idx, parentId).slice(); }
    else { parentId = D === 0 ? null : idx[above.id].chain[D - 1]; orderedIds = childrenIds(idx, parentId).slice(); }
    if (parentId != null && idx[dragId] && idx[parentId] && idx[parentId].chain.indexOf(dragId) >= 0) return null; // no cycle
    orderedIds = orderedIds.filter((x) => x !== dragId);
    let insertIdx;
    if (!above || parentId === above.id) insertIdx = 0;
    else { const branch = idx[above.id].chain[D]; const bi = orderedIds.indexOf(branch); insertIdx = bi < 0 ? orderedIds.length : bi + 1; }
    orderedIds.splice(insertIdx, 0, dragId);
    const lineTop = (below ? below.rect.top : (above ? above.rect.bottom : treeRect.top)) - treeRect.top + tree.scrollTop;
    const lineLeft = (baseLeft - treeRect.left) + D * INDENT;
    return { parentId, orderedIds, lineTop, lineLeft };
  }
  function ensureFolderDnD(tree) {
    if (_folderDnDBound) return; _folderDnDBound = true;
    tree.addEventListener("dragover", (e) => { if (!e.dataTransfer.types.includes("text/folder")) return; e.preventDefault(); const info = computeFolderDrop(e.clientX, e.clientY); if (info) { _pendingDrop = info; showDropline(info.lineTop, info.lineLeft); } else { _pendingDrop = null; hideDropline(); } });
    tree.addEventListener("drop", async (e) => { if (!e.dataTransfer.types.includes("text/folder")) return; e.preventDefault(); const fid = +e.dataTransfer.getData("text/folder"), info = _pendingDrop; hideDropline(); _pendingDrop = null; if (info && fid) { await api("/api/folders/reorder/", "POST", { parent_id: info.parentId, ordered_ids: info.orderedIds }); if (info.parentId) state.expanded.add(info.parentId); await loadFolders(); } });
    tree.addEventListener("dragleave", (e) => { if (e.target === tree) hideDropline(); });
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

  // Colour modes: a shared palette of colours, but each tool (pen / highlighter /
  // text) keeps its OWN selected swatch — selecting a colour for one tool does not
  // change another's. The picker edits the selected swatch; all persists across notes.
  function colorToolKey() { const t = editor.tool(); return t === "highlighter" ? "highlighter" : t === "text" ? "text" : "pen"; }
  function curPalette() { return state.palettes[colorToolKey()]; }
  function renderPalette() {
    const box = $("#palette"); box.innerHTML = ""; const k = colorToolKey(), pal = state.palettes[k], sel = state.colorSel[k];
    pal.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "pal" + (i === sel ? " selected" : "");
      b.style.background = c; b.title = c + " — click to use · right-click to remove";
      b.onclick = () => selectColorMode(i);
      b.oncontextmenu = (e) => { e.preventDefault(); if (pal.length > 1) { pal.splice(i, 1); if (state.colorSel[k] >= pal.length) state.colorSel[k] = pal.length - 1; applyAllColors(); syncColorUI(); saveColorState(); } };
      box.append(b);
    });
    const add = document.createElement("button"); add.className = "pal add"; add.textContent = "+"; add.title = "Add a colour to this tool's palette";
    add.onclick = () => { const c = $("#active-color").value; pal.push(c); state.colorSel[k] = pal.length - 1; applyAllColors(); syncColorUI(); saveColorState(); };
    box.append(add);
  }
  function saveColorState() { localStorage.setItem("nd_palettes", JSON.stringify(state.palettes)); localStorage.setItem("nd_colorsel", JSON.stringify(state.colorSel)); }
  function applyAllColors() { editor.setColors({ pen: state.palettes.pen[state.colorSel.pen], highlighter: state.palettes.highlighter[state.colorSel.highlighter], text: state.palettes.text[state.colorSel.text] }); }
  function syncColorUI() { renderPalette(); const ac = $("#active-color"); if (ac) ac.value = curPalette()[state.colorSel[colorToolKey()]] || "#1a1a1a"; }
  function selectColorMode(i) { const k = colorToolKey(); state.colorSel[k] = i; const c = state.palettes[k][i]; if (editor.isEditingRich()) editor.richCommand("foreColor", c); else editor.setToolColor(c); syncColorUI(); saveColorState(); }
  function setActiveModeColor(newColor) { const k = colorToolKey(); state.palettes[k][state.colorSel[k]] = newColor; if (editor.isEditingRich()) editor.richCommand("foreColor", newColor); else editor.setToolColor(newColor); syncColorUI(); saveColorState(); }
  function syncPalette() { applyAllColors(); syncColorUI(); }

  // Stroke sizes: per-tool preset lists (like colours) with an "add" option.
  function sizeToolKey() { return editor.tool() === "highlighter" ? "highlighter" : "pen"; }
  function renderSizeDropdown() {
    const sel = $("#pen-size-select"); if (!sel) return; const k = sizeToolKey();
    sel.innerHTML = ""; state.sizes[k].forEach((s, i) => { const o = document.createElement("option"); o.value = i; o.textContent = s + " px"; sel.append(o); });
    sel.value = String(Math.min(state.sizeSel[k], state.sizes[k].length - 1));
  }
  function selectSize(i) { const k = sizeToolKey(); state.sizeSel[k] = i; editor.setToolSize(state.sizes[k][i]); saveSizeState(); }
  function addSize() { const v = prompt("New stroke size (px):", "3"); if (v == null) return; const n = parseFloat(v); if (!(n > 0)) return; const k = sizeToolKey(); if (!state.sizes[k].includes(n)) state.sizes[k].push(n); state.sizes[k].sort((a, b) => a - b); state.sizeSel[k] = state.sizes[k].indexOf(n); saveSizeState(); renderSizeDropdown(); editor.setToolSize(n); }
  function removeSize() { const k = sizeToolKey(); if (state.sizes[k].length <= 1) { toast("Keep at least one size"); return; } const i = state.sizeSel[k]; state.sizes[k].splice(i, 1); state.sizeSel[k] = Math.max(0, Math.min(i, state.sizes[k].length - 1)); editor.setToolSize(state.sizes[k][state.sizeSel[k]]); saveSizeState(); renderSizeDropdown(); }
  function saveSizeState() { localStorage.setItem("nd_sizes", JSON.stringify(state.sizes)); localStorage.setItem("nd_sizesel", JSON.stringify(state.sizeSel)); }
  function applySizes() { editor.setSizes({ pen: state.sizes.pen[state.sizeSel.pen], highlighter: state.sizes.highlighter[state.sizeSel.highlighter] }); }

  // ========================= OPTION PANELS =========================
  function updateOptionPanels() {
    const info = editor.selectionInfo();
    const has = info.count > 0;
    // object properties bar — only visible when something is selected
    $("#object-opts").hidden = !has; $("#sel-count").textContent = info.count > 1 ? `${info.count} selected` : "";
    const selType = info.count === 1 && info.obj ? info.obj.type : null;
    const isShape = selType === "shape";
    $("#sel-edit").hidden = !(selType === "table" || selType === "chart");
    $("#sel-crop").hidden = !(selType === "image");
    $("#shape-controls").hidden = !isShape;
    // The selection-colour swatch is meaningless for shapes (own pickers), images and media.
    $("#sel-color-wrap").style.display = (selType === "shape" || selType === "image" || selType === "media") ? "none" : "";
    if (has) refreshGeom();
    if (isShape) { const s = editor.shapeInfo(); if (s) { const isLine = s.shape === "line"; $("#shape-fill").value = s.fill && s.fill[0] === "#" ? s.fill : rgbToHex(s.fill) || "#5b7cfa"; $("#shape-fill-none").classList.toggle("on", !s.fill); $("#shape-stroke").value = s.stroke && s.stroke[0] === "#" ? s.stroke : rgbToHex(s.stroke) || "#1a1a1a"; $("#shape-stroke-w").value = s.strokeWidth; $("#shape-fill").parentElement.style.display = isLine ? "none" : ""; $("#shape-fill-none").style.display = isLine ? "none" : ""; } }
    // tool panels (pen / text / code)
    let panel = null;
    if (selType === "text") panel = "text"; else if (selType === "code") panel = "code";
    if (!panel) { const t = editor.tool(); if (t === "pen" || t === "highlighter") panel = "pen"; else if (t === "text") panel = "text"; }
    $("#pen-opts").classList.toggle("hidden", panel !== "pen");
    $("#text-opts").hidden = panel !== "text"; $("#code-opts").hidden = panel !== "code";
    if (panel === "pen") { renderSizeDropdown(); }
    else if (panel === "text") { const o = info.obj || {}; if (o.fontSize) $("#text-size").value = Math.round(o.fontSize); if (o.family) $("#text-family").value = o.family; $("#text-bold").classList.toggle("on", !!o.bold); $("#text-italic").classList.toggle("on", !!o.italic); $("#text-underline").classList.toggle("on", !!o.underline); $("#text-strike").classList.toggle("on", !!o.strike); $("#text-hl-toggle").classList.toggle("on", !!o.highlight); if (o.highlight) $("#text-hl").value = o.highlight; if (o.lineHeight) $("#text-linespacing").value = String(o.lineHeight); const al = o.align || "left"; document.querySelectorAll("#text-align button").forEach((b) => b.classList.toggle("on", b.dataset.align === al)); }
    else if (panel === "code") { const o = info.obj || {}; if (o.language) $("#code-lang").value = o.language; }
  }

  // Push current geometry into the W/H/↻ fields (skip a field the user is typing in).
  function refreshGeom() {
    const g = editor.geometryInfo(); if (!g) return;
    const a = document.activeElement;
    if (a !== $("#geo-w")) $("#geo-w").value = g.w;
    if (a !== $("#geo-h")) $("#geo-h").value = g.h;
    if (a !== $("#geo-rot")) $("#geo-rot").value = g.rotationDeg;
    $("#geo-h").disabled = g.autoH || !g.canSize; $("#geo-h").title = g.autoH ? "Height is automatic (set by the content)" : "Height";
    $("#geo-w").disabled = !g.canSize; $("#geo-rot").disabled = !g.canRotate;
    // corner rounding only applies to shapes / images / media
    $("#geo-radius").style.display = g.canRound ? "" : "none";
    $("#geo-radius-lbl").style.display = g.canRound ? "" : "none";
    if (g.canRound && a !== $("#geo-radius")) $("#geo-radius").value = g.radius;
  }

  function doInsert(cmd) {
    if (cmd === "image") $("#image-input").click();
    else if (cmd === "code") editor.addCode();
    else if (cmd === "sticky") editor.addSticky();
    else if (cmd === "table") { editor.addTable(); openTableEditor(); }
    else if (cmd === "chart") { editor.addChart(); openChartEditor(); }
    else if (cmd === "math") editor.addMath();
    else if (cmd.startsWith("shape:")) { editor.addShape(cmd.slice(6)); updateOptionPanels(); scheduleSave(); }
    else if (cmd.startsWith("media:")) { const act = cmd.slice(6); if (act === "audio-file") { state.mediaKind = "audio"; $("#media-input").click(); } else if (act === "video-file") { state.mediaKind = "video"; $("#media-input").click(); } else if (act === "audio-rec") openRecorder("audio"); else if (act === "video-rec") openRecorder("video"); }
  }
  function doArrange(a) { if (a === "front") editor.bringToFront(); else if (a === "forward") editor.stepForward(); else if (a === "backward") editor.stepBackward(); else if (a === "back") editor.sendToBack(); }

  // Common code languages (value must be one hljs recognises) for the picker.
  const CODE_LANGS = [
    ["python", "Python"], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
    ["html", "HTML"], ["css", "CSS"], ["json", "JSON"], ["java", "Java"], ["kotlin", "Kotlin"],
    ["cpp", "C++"], ["c", "C"], ["csharp", "C#"], ["go", "Go"], ["rust", "Rust"], ["swift", "Swift"],
    ["ruby", "Ruby"], ["php", "PHP"], ["sql", "SQL"], ["bash", "Bash / shell"],
    ["yaml", "YAML"], ["markdown", "Markdown"], ["plaintext", "Plain text"],
  ];
  function setCodeLang(lang) { editor.setCodeLanguage(lang); updateOptionPanels(); scheduleSave(); }

  // Right-click menu for an object: reorder + quick actions.
  function openObjectCtx(x, y) {
    const info = editor.selectionInfo();
    const selType = info.count === 1 && info.obj ? info.obj.type : null;
    const items = [
      { header: "Arrange" },
      { label: "Bring to front", fn: () => { editor.bringToFront(); scheduleSave(); } },
      { label: "Bring forward", fn: () => { editor.stepForward(); scheduleSave(); } },
      { label: "Send backward", fn: () => { editor.stepBackward(); scheduleSave(); } },
      { label: "Send to back", fn: () => { editor.sendToBack(); scheduleSave(); } },
      { sep: true },
      { label: "Rotate 90°", fn: () => { editor.rotateSelection(); scheduleSave(); } },
    ];
    if (selType === "table" || selType === "chart") items.push({ label: "Edit…", fn: () => { selType === "table" ? openTableEditor() : openChartEditor(); } });
    if (selType === "image") items.push({ label: "Crop…", fn: () => openCropEditor() });
    if (selType === "code") {
      const cur = info.obj.language || "plaintext";
      items.push({ sep: true }, { header: "Highlight as" });
      CODE_LANGS.forEach(([val, name]) => items.push({ label: (val === cur ? "● " : "&nbsp;&nbsp;&nbsp;") + esc(name), fn: () => setCodeLang(val) }));
    }
    items.push({ sep: true }, { label: "Delete", danger: true, fn: () => { editor.deleteSelection(); scheduleSave(); } });
    openCtx(x, y, items);
  }

  // ========================= MODAL =========================
  function openModal(title, bodyHTML, onOk) { $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHTML; $("#modal .modal-card").classList.remove("wide"); $("#modal").hidden = false; const ok = $("#modal-ok"), cancel = $("#modal-cancel"); const close = () => { $("#modal").hidden = true; }; ok.onclick = () => { if (onOk($("#modal-body")) !== false) close(); }; cancel.onclick = close; return close; }
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
    // Local style state so changing rows/cols mid-edit doesn't discard style tweaks.
    const style = { headerRow: !!o.headerRow, headerFill: o.headerFill || "#eef1ff", zebra: !!o.altFill, altFill: o.altFill || "#f4f6ff", gridColor: o.gridColor || "#c9cede", textColor: o.textColor || "#1a1a1a", align: o.align || "left" };
    const ensure = () => { for (let r = 0; r < rows; r++) { data[r] = data[r] || []; for (let c = 0; c < cols; c++) if (data[r][c] == null) data[r][c] = ""; } data.length = rows; };
    const body = () => {
      ensure();
      let grid = `<div class="modal-grid" style="grid-template-columns:repeat(${cols},1fr)">`;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid += `<input data-r="${r}" data-c="${c}" value="${(data[r][c] || "").replace(/"/g, "&quot;")}">`;
      grid += `</div>`;
      return `
        <div class="tbl-nums">
          <label>Rows <input id="t-rows" type="number" min="1" max="30" value="${rows}"></label>
          <label>Columns <input id="t-cols" type="number" min="1" max="12" value="${cols}"></label>
        </div>
        <div class="tbl-opt">
          <label class="tbl-check"><input type="checkbox" id="t-header" ${style.headerRow ? "checked" : ""}> Shade the header row</label>
          <input type="color" id="t-hfill" class="tbl-swatch" value="${style.headerFill}" title="Header background colour">
        </div>
        <div class="tbl-opt">
          <label class="tbl-check"><input type="checkbox" id="t-zebra" ${style.zebra ? "checked" : ""}> Shade every other row <span class="tbl-hint">(“zebra” stripes for readability)</span></label>
          <input type="color" id="t-zfill" class="tbl-swatch" value="${style.altFill}" title="Alternating row colour">
        </div>
        <div class="tbl-opt"><span class="tbl-optlbl">Grid line colour</span><input type="color" id="t-grid" class="tbl-swatch" value="${style.gridColor}"></div>
        <div class="tbl-opt"><span class="tbl-optlbl">Text colour</span><input type="color" id="t-text" class="tbl-swatch" value="${style.textColor}"></div>
        <div class="tbl-opt"><span class="tbl-optlbl">Text alignment</span><select id="t-align" class="tbl-select"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div>
        <div class="tbl-cells-label">Cell contents — click a cell to type</div>${grid}`;
    };
    const rerender = () => { $("#modal-body").innerHTML = body(); wireControls(); };
    const readGrid = () => { $("#modal-body").querySelectorAll(".modal-grid input").forEach((inp) => { data[+inp.dataset.r][+inp.dataset.c] = inp.value; }); };
    const readStyle = () => { style.headerRow = $("#t-header").checked; style.headerFill = $("#t-hfill").value; style.zebra = $("#t-zebra").checked; style.altFill = $("#t-zfill").value; style.gridColor = $("#t-grid").value; style.textColor = $("#t-text").value; style.align = $("#t-align").value; };
    const wireControls = () => {
      $("#t-align").value = style.align;
      $("#t-rows").onchange = () => { readGrid(); readStyle(); rows = Math.max(1, Math.min(30, +$("#t-rows").value || 1)); rerender(); };
      $("#t-cols").onchange = () => { readGrid(); readStyle(); cols = Math.max(1, Math.min(12, +$("#t-cols").value || 1)); rerender(); };
    };
    openModal("Edit table", body(), () => {
      readGrid(); readStyle();
      editor.updateSelected({ rows, cols, data, headerRow: style.headerRow, headerFill: style.headerFill, altFill: style.zebra ? style.altFill : null, gridColor: style.gridColor, textColor: style.textColor, align: style.align });
      scheduleSave();
    });
    $("#modal .modal-card").classList.add("wide");
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

  // ========================= IMAGE CROP =========================
  function openCropEditor() {
    const o = editor.getSelected(); if (!o || o.type !== "image") return;
    const modal = $("#crop-modal"), img = $("#crop-img"), stage = $("#crop-stage"), box = $("#crop-box");
    let dw = 0, dh = 0;
    const clampBox = () => {
      let x = box.offsetLeft, y = box.offsetTop, w = box.offsetWidth, h = box.offsetHeight;
      w = Math.max(20, Math.min(w, dw)); h = Math.max(20, Math.min(h, dh));
      x = Math.max(0, Math.min(x, dw - w)); y = Math.max(0, Math.min(y, dh - h));
      box.style.left = x + "px"; box.style.top = y + "px"; box.style.width = w + "px"; box.style.height = h + "px";
    };
    img.onload = () => {
      const maxW = Math.min(560, window.innerWidth - 80), maxH = Math.min(420, window.innerHeight - 170);
      const nw = img.naturalWidth, nh = img.naturalHeight, s = Math.min(maxW / nw, maxH / nh, 1);
      dw = Math.round(nw * s); dh = Math.round(nh * s);
      stage.style.width = dw + "px"; stage.style.height = dh + "px";
      const cr = o.crop || { x: 0, y: 0, w: 1, h: 1 };
      box.style.left = (cr.x * dw) + "px"; box.style.top = (cr.y * dh) + "px"; box.style.width = (cr.w * dw) + "px"; box.style.height = (cr.h * dh) + "px";
    };
    img.src = o.src; modal.hidden = false;
    let drag = null;
    const onMove = (e) => {
      if (!drag) return; const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (drag.mode === "move") { box.style.left = (drag.l + dx) + "px"; box.style.top = (drag.t + dy) + "px"; }
      else { let l = drag.l, t = drag.t, w = drag.w, h = drag.hh, c = drag.mode;
        if (c.includes("l")) { l = drag.l + dx; w = drag.w - dx; } if (c.includes("r")) { w = drag.w + dx; }
        if (c.includes("t")) { t = drag.t + dy; h = drag.hh - dy; } if (c.includes("b")) { h = drag.hh + dy; }
        box.style.left = l + "px"; box.style.top = t + "px"; box.style.width = Math.max(20, w) + "px"; box.style.height = Math.max(20, h) + "px"; }
      clampBox();
    };
    const onUp = () => { drag = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    box.onpointerdown = (e) => { const h = e.target.dataset && e.target.dataset.h; drag = { mode: h || "move", sx: e.clientX, sy: e.clientY, l: box.offsetLeft, t: box.offsetTop, w: box.offsetWidth, hh: box.offsetHeight }; e.preventDefault(); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); };
    const close = () => { modal.hidden = true; box.onpointerdown = null; };
    $("#crop-cancel").onclick = close;
    $("#crop-reset").onclick = () => { box.style.left = "0px"; box.style.top = "0px"; box.style.width = dw + "px"; box.style.height = dh + "px"; };
    $("#crop-ok").onclick = () => {
      if (!dw || !dh || !img.naturalWidth) { close(); return; }
      const crop = { x: box.offsetLeft / dw, y: box.offsetTop / dh, w: box.offsetWidth / dw, h: box.offsetHeight / dh };
      const nw = img.naturalWidth, nh = img.naturalHeight, srcAspect = (crop.w * nw) / (crop.h * nh);
      editor.updateSelected({ crop, h: o.w / srcAspect }); scheduleSave(); close();
    };
  }

  // ========================= AUDIO / VIDEO =========================
  async function openMediaPlayer() {
    const o = editor.getSelected(); if (!o || o.type !== "media") return;
    const modal = $("#media-modal"), box = $("#media-player");
    box.innerHTML = ""; modal.hidden = false;
    // Server URLs (/api/media/…) play & seek directly. Legacy inline clips are data:
    // URLs, which <video> can't play reliably — convert those to a blob URL first.
    let url = o.src, objUrl = null;
    if (o.src && o.src.startsWith("data:")) { try { const blob = await (await fetch(o.src)).blob(); objUrl = URL.createObjectURL(blob); url = objUrl; } catch (e) {} }
    const el = document.createElement(o.mediaType === "video" ? "video" : "audio");
    el.src = url; el.controls = true; el.autoplay = true; el.playsInline = true;
    el.onerror = () => { box.innerHTML = '<div style="color:var(--muted);padding:12px">Could not play this clip.</div>'; };
    box.append(el);
    $("#media-close").onclick = () => { try { el.pause(); } catch (e) {} if (objUrl) URL.revokeObjectURL(objUrl); modal.hidden = true; box.innerHTML = ""; };
  }
  // Link dialog: edit display text + URL together. Pre-fills from the selection or
  // the link at the caret; if you type a URL with the text empty, it mirrors into text.
  function openLinkDialog() {
    if (!editor.isEditingRich()) { toast("Double-click a text box first"); return; }
    const ctx = editor.linkContext();
    const modal = $("#link-modal"), textIn = $("#link-text"), urlIn = $("#link-url"), removeB = $("#link-remove");
    $("#link-title").textContent = ctx.inLink ? "Edit link" : "Add link";
    textIn.value = ctx.text || ""; urlIn.value = ctx.url || ""; removeB.hidden = !ctx.inLink;
    let textLocked = !!(ctx.text && ctx.text.trim()); // don't auto-fill once there's text
    textIn.oninput = () => { textLocked = !!textIn.value.trim(); };
    urlIn.oninput = () => { if (!textLocked) textIn.value = urlIn.value; };
    modal.hidden = false; setTimeout(() => (ctx.text ? urlIn : textIn).focus(), 0);
    const close = () => { modal.hidden = true; editor.refocusText(); };
    $("#link-ok").onclick = () => { const url = urlIn.value.trim(); if (!url) { close(); return; } editor.applyLink(textIn.value.trim() || url, url); scheduleSave(); close(); };
    $("#link-cancel").onclick = close;
    removeB.onclick = () => { editor.removeLink(); scheduleSave(); close(); };
  }

  // List-marker style: markers match their text by default; this nudges size/colour.
  function openMarkerDialog() {
    const o = editor.getSelected();
    const editing = editor.isEditingRich();
    if (!editing && (!o || o.type !== "text")) { toast("Select or edit a text box with a list first"); return; }
    const info = editor.markerInfo();
    const modal = $("#marker-modal"), scale = $("#marker-scale"), sval = $("#marker-scale-val"), color = $("#marker-color");
    const curScale = info.scale || 1, curColor = info.color;
    scale.value = curScale; sval.textContent = Math.round(curScale * 100) + "%";
    if (curColor) color.value = curColor;
    scale.oninput = () => { sval.textContent = Math.round(scale.value * 100) + "%"; editor.setMarkerStyle(parseFloat(scale.value), undefined); scheduleSave(); };
    color.oninput = () => { editor.setMarkerStyle(null, color.value); scheduleSave(); };
    $("#marker-color-clear").onclick = () => { editor.setMarkerStyle(null, null); scheduleSave(); };
    modal.hidden = false;
    $("#marker-close").onclick = () => { modal.hidden = true; editor.refocusText(); };
  }

  let recState = null;
  async function openRecorder(kind) {
    const modal = $("#rec-modal"), preview = $("#rec-preview"), status = $("#rec-status"), startB = $("#rec-start"), stopB = $("#rec-stop");
    $("#rec-title").textContent = kind === "video" ? "Record video" : "Record audio";
    preview.classList.toggle("audio-only", kind !== "video");
    modal.hidden = false; startB.hidden = true; stopB.hidden = true; status.textContent = "Requesting permission…";
    let stream, recorder, chunks = [];
    const cleanup = () => { if (recorder && recorder.state !== "inactive") try { recorder.stop(); } catch (e) {} if (stream) stream.getTracks().forEach((t) => t.stop()); preview.srcObject = null; };
    try { stream = await navigator.mediaDevices.getUserMedia(kind === "video" ? { audio: true, video: true } : { audio: true }); }
    catch (e) { status.textContent = "Could not access " + (kind === "video" ? "camera/mic" : "microphone") + " — check browser permissions."; $("#rec-cancel").onclick = () => { cleanup(); modal.hidden = true; }; return; }
    if (kind === "video") { preview.srcObject = stream; }
    status.textContent = "Ready to record."; startB.hidden = false;
    startB.onclick = () => {
      chunks = [];
      // pick a mime the browser can actually record
      const prefs = kind === "video" ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      let mime = ""; try { mime = prefs.find((m) => MediaRecorder.isTypeSupported(m)) || ""; } catch (e) {}
      try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { recorder = new MediaRecorder(stream); }
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : (recorder.mimeType || mime) });
        cleanup(); modal.hidden = true;
        if (!blob.size) { toast("Recording was empty — try again"); return; }
        try { const u = await uploadMedia(blob, blob.type); editor.addMediaUrl(kind, u, kind + "-recording"); scheduleSave(); }
        catch (e) { toast("Couldn't save the recording"); }
      };
      recorder.start(1000); startB.hidden = true; stopB.hidden = false; status.textContent = "Recording… ●";
    };
    stopB.onclick = () => { if (recorder && recorder.state !== "inactive") recorder.stop(); };
    $("#rec-cancel").onclick = () => { cleanup(); modal.hidden = true; };
  }

  // ========================= TOOLS =========================
  function setTool(tool) { editor.setTool(tool); document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool)); updateOptionPanels(); syncColorUI(); renderSizeDropdown(); }

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
      onEditObject: (type) => { if (type === "table") openTableEditor(); else if (type === "chart") openChartEditor(); else if (type === "math") openMathEditor(); else if (type === "media") openMediaPlayer(); },
      onEditText: () => updateOptionPanels(),
      onObjectMenu: (x, y) => openObjectCtx(x, y),
      onTransform: () => refreshGeom(), // live-update the W/H/↻ fields while dragging handles
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
    // While editing a rich-text box, clicking a toolbar BUTTON must not steal focus
    // (which would drop the text selection and close the editor). Inputs/selects keep focus.
    $("#toolbar").addEventListener("mousedown", (e) => { if (editor.isEditingRich() && !e.target.closest("input, select, textarea")) e.preventDefault(); });
    // live while just drawing; on 'change' (picker closed) while editing rich text, so it doesn't steal focus mid-drag
    $("#active-color").oninput = (e) => { if (!editor.isEditingRich()) setActiveModeColor(e.target.value); };
    $("#active-color").onchange = (e) => { if (editor.isEditingRich()) setActiveModeColor(e.target.value); };
    $("#pen-size-select").onchange = (e) => selectSize(+e.target.value);
    $("#pen-size-add").onclick = addSize;
    $("#pen-size-del").onclick = removeSize;
    $("#text-linespacing").onchange = (e) => { if (editor.isEditingRich()) editor.richCommand("lineHeight", +e.target.value); else editor.setTextProp("lineHeight", +e.target.value); };
    // one Insert menu for everything
    $("#insert-btn").onclick = (e) => { e.stopPropagation(); $("#insert-menu").hidden = !$("#insert-menu").hidden; };
    $("#insert-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#insert-menu").hidden = true; doInsert(b.dataset.insert); }; });
    $("#image-input").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) editor.addImageFromFile(f); };
    $("#media-input").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; const kind = (f.type && f.type.startsWith("video")) ? "video" : (f.type && f.type.startsWith("audio")) ? "audio" : (state.mediaKind || "audio"); try { const u = await uploadMedia(f, f.type); editor.addMediaUrl(kind, u, f.name); scheduleSave(); } catch (err) { toast("Couldn't import that file"); } };
    // shape fill / outline
    $("#shape-fill").oninput = (e) => { editor.setShapeProp("fill", e.target.value); $("#shape-fill-none").classList.remove("on"); scheduleSave(); };
    $("#shape-fill-none").onclick = () => { editor.setShapeProp("fill", null); $("#shape-fill-none").classList.add("on"); scheduleSave(); };
    $("#shape-stroke").oninput = (e) => { editor.setShapeProp("stroke", e.target.value); scheduleSave(); };
    $("#shape-stroke-w").oninput = (e) => { editor.setShapeProp("strokeWidth", +e.target.value); scheduleSave(); };
    // geometry — applies to any selection (single object or a group)
    $("#geo-w").oninput = (e) => { editor.setSelSize(+e.target.value, null); scheduleSave(); };
    $("#geo-h").oninput = (e) => { editor.setSelSize(null, +e.target.value); scheduleSave(); };
    $("#geo-rot").oninput = (e) => { editor.setSelRotation(+e.target.value); scheduleSave(); };
    $("#geo-radius").oninput = (e) => { editor.setCornerRadius(+e.target.value); scheduleSave(); };
    // arrange (z-order) menu
    $("#arrange-btn").onclick = (e) => { e.stopPropagation(); $("#arrange-menu").hidden = !$("#arrange-menu").hidden; };
    $("#arrange-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#arrange-menu").hidden = true; doArrange(b.dataset.arrange); scheduleSave(); }; });
    $("#sel-edit").onclick = () => { const info = editor.selectionInfo(); if (info.obj && info.obj.type === "table") openTableEditor(); else if (info.obj && info.obj.type === "chart") openChartEditor(); };
    // alignment: rich per-paragraph while editing, else whole box
    const ALIGN_CMD = { left: "justifyLeft", center: "justifyCenter", right: "justifyRight" };
    document.querySelectorAll("#text-align button").forEach((b) => { b.onclick = () => { if (editor.isEditingRich()) editor.richCommand(ALIGN_CMD[b.dataset.align]); else editor.setTextProp("align", b.dataset.align); }; });

    // text options — while EDITING a rich box, format the selection; otherwise the whole box
    // 'change' (not 'input') so multi-digit sizes can be typed while editing rich text without losing focus
    $("#text-size").onchange = (e) => { if (editor.isEditingRich()) editor.richCommand("fontSize", e.target.value + "px"); else editor.setTextProp("fontSize", +e.target.value); };
    $("#text-size").oninput = (e) => { if (!editor.isEditingRich()) editor.setTextProp("fontSize", +e.target.value); };
    $("#text-family").onchange = (e) => { if (editor.isEditingRich()) editor.richCommand("fontName", e.target.value); else editor.setTextProp("family", e.target.value); };
    const RICH_CMD = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };
    const tgl = (id, prop) => { $(id).onclick = () => { if (editor.isEditingRich()) editor.richCommand(RICH_CMD[prop]); else { const on = !$(id).classList.contains("on"); $(id).classList.toggle("on", on); editor.setTextProp(prop, on); } }; };
    tgl("#text-bold", "bold"); tgl("#text-italic", "italic"); tgl("#text-underline", "underline"); tgl("#text-strike", "strike");
    $("#text-bullet").onclick = () => editor.richCommand("insertUnorderedList");
    $("#text-number").onclick = () => editor.richCommand("insertOrderedList");
    $("#text-link").onclick = () => openLinkDialog();
    $("#text-marker").onclick = () => openMarkerDialog();
    $("#text-hl-toggle").onclick = () => { const on = !$("#text-hl-toggle").classList.contains("on"); $("#text-hl-toggle").classList.toggle("on", on); if (editor.isEditingRich()) editor.richCommand("hiliteColor", on ? $("#text-hl").value : "transparent"); else editor.setTextProp("highlight", on ? $("#text-hl").value : null); };
    $("#text-hl").oninput = (e) => { if (editor.isEditingRich()) editor.richCommand("hiliteColor", e.target.value); else if ($("#text-hl-toggle").classList.contains("on")) editor.setTextProp("highlight", e.target.value); };
    $("#code-lang").onchange = (e) => editor.setCodeLanguage(e.target.value);
    $("#note-sort").onchange = () => loadNotes();

    // colours + sizes: clamp saved indices, apply to the editor, render the bar
    ["pen", "highlighter", "text"].forEach((k) => { if (!state.palettes[k] || !state.palettes[k].length) state.palettes[k] = DEFAULT_PALETTES[k].slice(); if (state.colorSel[k] == null || state.colorSel[k] >= state.palettes[k].length) state.colorSel[k] = 0; });
    ["pen", "highlighter"].forEach((k) => { if (state.sizeSel[k] == null || state.sizeSel[k] >= state.sizes[k].length) state.sizeSel[k] = 0; });
    applyAllColors(); applySizes(); syncColorUI(); renderSizeDropdown();

    // per-page menu items
    $("#page-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#page-menu").hidden = true; const i = state.pageMenuIndex, act = b.dataset.page; if (act === "add-after") { editor.addPage({ index: i + 1 }); } else if (act === "add-before") { editor.addPage({ index: i }); } else if (act === "import") { state.pendingImport = { mode: "current", at: i + 1 }; $("#pdf-input").click(); } else if (act === "resize") resizePageDialog(false); else if (act === "rotate") editor.rotatePage(i); else if (act === "bg") pickColor(editor.pageColor(i), (c) => editor.setPageBg(i, c)); else if (act === "ruled") editor.setPageRuled(i, !editor.pageRuled(i)); else if (act === "default") { editor.setDefaults({ pageColor: editor.pageColor(i), ruled: editor.pageRuled(i) }); toast("New pages will match this page"); } else if (act === "delete") { if (confirm("Delete this page?")) editor.deletePage(i); } scheduleSave(); }; });

    // all-pages menu
    $("#pages-btn").onclick = (e) => { e.stopPropagation(); $("#pages-menu").hidden = !$("#pages-menu").hidden; };
    $("#pages-menu").querySelectorAll("button").forEach((b) => { b.onclick = () => { $("#pages-menu").hidden = true; const act = b.dataset.all; if (act === "resize") resizePageDialog(true); else if (act === "rotate") editor.rotateAllPages(); else if (act === "bg") pickColor(editor.pageColor(), (c) => editor.setAllPagesBg(c)); else if (act === "ruled-on") editor.setAllRuled(true); else if (act === "ruled-off") editor.setAllRuled(false); scheduleSave(); }; });

    // selection actions
    $("#sel-color").oninput = (e) => editor.applyColor(e.target.value);
    $("#sel-rotate").onclick = () => editor.rotateSelection();
    $("#sel-crop").onclick = () => openCropEditor();
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
    document.addEventListener("click", () => { if (suppressDocClick) { suppressDocClick = false; return; } $("#export-menu").hidden = true; $("#pages-menu").hidden = true; $("#page-menu").hidden = true; $("#insert-menu").hidden = true; $("#arrange-menu").hidden = true; hideCtx(); });
    window.addEventListener("scroll", () => { hideCtx(); $("#page-menu").hidden = true; }, true);

    // keyboard
    document.addEventListener("keydown", (e) => {
      const ae = document.activeElement, tag = ae.tagName;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || ae.isContentEditable;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "s") { e.preventDefault(); flushSave().then(() => toast("Saved")); return; }
      // Undo/redo: while typing IN A TEXT BOX or dropdown, leave native behaviour.
      // But the note-title input hands undo back to the drawing (blur first).
      const inTextEntry = tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable || (tag === "INPUT" && ae.id !== "note-title");
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) { if (inTextEntry) return; if (ae.id === "note-title") ae.blur(); e.preventDefault(); if (state.view === "editor" && state.currentNote && editor.canUndo()) editor.undo(); else appUndoPop(); return; }
      if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) { if (inTextEntry) return; if (ae.id === "note-title") ae.blur(); e.preventDefault(); if (state.currentNote) editor.redo(); return; }
      // copy / cut / paste of selected objects (only when NOT typing — text keeps native paste)
      const canObj = !inTextEntry && state.currentNote && state.view === "editor";
      if ((e.ctrlKey || e.metaKey) && key === "c" && canObj) { if (editor.hasSelection()) { editor.copySelection(); toast("Copied"); } return; }
      if ((e.ctrlKey || e.metaKey) && key === "x" && canObj) { if (editor.hasSelection()) { editor.copySelection(); editor.deleteSelection(); toast("Cut"); } return; }
      if ((e.ctrlKey || e.metaKey) && key === "v" && canObj) { if (editor.hasClipboard()) { e.preventDefault(); editor.pasteClipboard(); toast("Pasted"); } return; }
      if (typing || !state.currentNote || state.view !== "editor") return;
      if (e.key === "Delete" || e.key === "Backspace") { if (editor.hasSelection()) { e.preventDefault(); editor.deleteSelection(); } return; }
      if (e.key === " ") editor.setSpace(true);
      const map = { v: "select", p: "pen", h: "highlighter", e: "eraser", t: "text" };
      if (map[key]) setTool(map[key]);
    });
    document.addEventListener("keyup", (e) => { if (e.key === " ") editor.setSpace(false); });

    // paste a screenshot / copied image straight onto the current note
    document.addEventListener("paste", (e) => {
      if (state.view !== "editor" || !state.currentNote) return;
      const ae = document.activeElement; if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA)$/.test(ae.tagName))) return; // let text boxes paste natively
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) { const file = it.getAsFile(); if (file) { editor.addImageFromFile(file); toast("Image pasted"); e.preventDefault(); } break; }
      }
    });

    setTool("select");
    setView("library");
    loadFolders();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
