# 📝 Notada

A local, single-device note-taking app built with Django. No accounts, no cloud.
Every note is one **unified canvas** — you type and draw on the same pages — and
each note is **automatically saved as a PDF on your device**.

## Features

- **One surface for everything** — no typed-vs-handwritten split. Draw with a pen
  or highlighter, drop in text boxes, and add images all on the same pages.
- **Smooth, variable-width ink** — strokes are curve-smoothed, and the pen width is
  a continuous slider (1–30px), not a few fixed sizes.
- **Zoom & pan** — pinch with two fingers to zoom, drag with one finger to draw.
  With a mouse/trackpad: `Ctrl/⌘ + scroll` (or pinch) to zoom, scroll to pan.
- **Auto-saved to PDF** — after each change a flattened PDF copy is written to disk
  under `NotadaPDFs/`, in a folder tree that mirrors your folders in the app.
  "Export" is just there for when you want to grab a copy somewhere else.
- **Select many at once** — with the Select tool, drag an empty area to lasso a
  group (or Shift/Ctrl-click to add). Then delete, recolour, rotate, or move them
  all together.
- **Full page control** (the **📄 Page ▾** menu):
  - **Add page** with a chosen size — A4 / Letter / Square presets or custom W×H,
    inserted before/after the current page or at the start/end.
  - **Insert a PDF** into the current note, after the current page.
  - **Resize** or **delete** the current page.
  - **Rotate the whole page 90°** (contents and all).
  - Quick-add: tap the blue **＋** between any two pages to drop in a blank page.
- **Two ways to import a PDF**:
  - **PDF as note** (note-list header) — the PDF becomes its own new note.
  - **Insert PDF** (Page ▾ menu) — its pages are inserted into the note you're
    editing so you can annotate them.
- **Images you can manipulate** — move (drag), resize (corner handle), rotate
  (top handle or “⟳ 90°”), reorder (Front/Back), and draw on top of them.
- **Organise by drag-and-drop** — drag a note card onto any folder/subfolder to move
  it, or right-click a note for a “Move to…” menu (plus pin / delete).
- **Folders & subfolders**, each with its own colour; full-text title search; pin
  notes; light / dark theme.
- **Export** a note as a PDF or as editable JSON.

### More editing power

- **Two screens** — a **Library** view (folders + notes, no editor) and a
  full-screen **Editor** view (no sidebar). Open a note to edit; “‹ Library” to go back.
- **Undo / redo** — `Ctrl/⌘+Z` and `Ctrl/⌘+Y` (or the ↶ ↷ buttons) undo edits inside a
  note, including group deletes. In the Library, `Ctrl/⌘+Z` (and the “Undo” toast button)
  reverses note/folder moves and deletions.
- **Independent pen & highlighter** — each keeps its own colour and width; changing one
  slider doesn’t affect the other.
- **Quick colour palette** — a few shared swatches for pen / highlighter / text.
  Click **＋** to add the current colour, right-click a swatch to remove it.
- **Richer text** — set an exact font size, font, **bold**/*italic*, and colour; text is
  multi-line and wraps to the box width (drag the corner to change the width).
- **Code blocks** — “{ } Code” inserts an auto-syntax-highlighted block; pick the
  language (Python, JavaScript, C++, C#, Java, Go, Rust, TypeScript, and more).
- **Per-page controls** — every page has a **⋯** button (top-right) to add a page
  before/after, insert a PDF after it, resize, rotate, change its background colour,
  toggle writing lines, or delete it.
- **All-pages controls** — the **📚 Pages ▾** menu resizes, rotates, recolours, or adds
  writing lines to *every* page at once, and can save the current size/colour as the
  default for new pages.
- **Writing lines** — ruled pages, toggleable per page or for all pages; they render in
  exported PDFs when on.
- **Bulk note actions** — `Ctrl/⌘+click` (or `Shift+click`) note cards to select several,
  then move or delete them together.
- **Move folders** — drag a folder onto another folder (or the “Move to top level” drop
  zone), or right-click a folder to move it.
- **Sticky notes** — “🗒 Sticky” drops a small note marker on the page; double-click it to
  open an editable note popup any time. Move it like any object.
- **Highlight text** — select a text box and pick a highlight colour to mark it (separate
  from the free-hand highlighter, which is still there for anything else).
- **Sort & search** — sort the note list by recently edited/created or name; search spans
  note **titles, their contents (text, code, sticky notes), and folder names** across
  every folder.
- **Independent pen/highlighter widths**, fine strokes down to **0.2px**, and text-box
  width that controls **wrapping** (font size is set with the size control, not by dragging).
- Double-click any text, code, or sticky box to edit it; empty text boxes stay put so you
  can size them before typing.
- **Tables** — “▦ Table” inserts a table; double-click (or ✎ Edit) to change rows, columns,
  cell data, header shading, zebra striping, grid/text colour, and alignment.
- **Charts** — “📊 Chart” inserts a bar / line / pie chart; edit the data points (label,
  value, colour), title, and bar width in a dialog.
- **Text alignment** — left / centre / right within a text box.
- The **text tool is one-shot**: it drops a single box (or edits the one you click on) and
  returns to the select tool, so clicking around never spawns stray empty boxes.
- The colour **palette swatches are editable** — click to use a colour, right-click a swatch
  to change it. Each tool (pen / highlighter / text) **remembers its own colour**, and those
  colours persist across notes and restarts until you change them again.
- **Math expressions (LaTeX)** — “∑ Math” opens an editor showing the **live render and the
  LaTeX side by side**, with buttons for common symbols (∫ ∑ √ π …). Double-click to re-edit.
- **Multi-line charts** — line charts support several lines (one colour each) with
  **shape-coded markers** per line; edit categories and per-line values in the dialog.
- **Table columns & rows are drag-resizable** — hover a border in a selected table and drag.
- **Rich text** now also has **underline**, **strikethrough**, and left/centre/right alignment,
  and a clearer highlight toggle.
- New notes open **fitted to the window** (no more tiny page in the corner).

## Running it

```bash
pip install -r requirements.txt      # Django only
python manage.py migrate             # first run: create the local database
python manage.py runserver
```

Open **http://127.0.0.1:8000/**.

> The app ships with pdf.js and jsPDF vendored locally in
> `notes/static/notes/vendor/`, so PDF import/export works fully offline — nothing
> is fetched from the internet at runtime.

## Tools (toolbar)

| Icon | Tool | Shortcut |
|------|------|----------|
| ✥ | Select / move / resize / rotate objects | `V` |
| ✏️ | Pen | `P` |
| 🖍️ | Highlighter | `H` |
| 🧽 | Eraser (removes strokes) | `E` |
| 🅃 | Text box (double-click a text box to re-edit) | `T` |
| ✋ | Pan the canvas | — |

`Delete` removes the selected object · `Ctrl/⌘ + S` forces a save.

## Where is my data?

Two places, both local to this device:

1. **`db.sqlite3`** — the editable source of truth (pages, strokes, text, images).
   Back up your notes by copying this file.
2. **`NotadaPDFs/`** — the auto-generated, flattened PDF copies, laid out in
   folders matching your app folders. These are regenerated on every save.

There are intentionally **no user accounts** — this is a personal, local app, so
`DEBUG = True` and a fixed `SECRET_KEY` are fine.

## How it fits together

- **Django** owns the folder/subfolder organisation, note metadata, and writes the
  PDF files to disk. The folder tree is mirrored as real directories under
  `NotadaPDFs/`.
- **The browser** runs the canvas editor (`notes/static/notes/js/editor.js`): an
  object model of pages containing strokes, text boxes and images, with a
  pan/zoom viewport. It generates the PDF client-side (jsPDF) and posts the bytes
  to Django, which saves them. PDF import is rendered client-side with pdf.js.
