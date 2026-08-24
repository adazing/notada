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
- **Tidy toolbar** — everything you can add lives in one **➕ Insert** menu (image, code,
  sticky, table, chart, math, shapes, audio/video). Select any object and an
  **object bar** appears with **W / H / ↻ (rotation)** — which work for *anything*
  (text, images, strokes, shapes, or a multi-select group) and **update live** as you
  drag the handles. **Right-click an object** to re-order it (bring to front / forward /
  backward / to back) or rotate/edit/delete it; z-order also lives in an **Arrange** menu.
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
- **Code blocks** — “{ } Code” (in the **➕ Insert** menu) inserts a syntax-highlighted
  block. Set the language two ways: the **‹/› Language** dropdown in the toolbar when the
  block is selected, or **right-click the block → “Highlight as”** (the current language is
  dotted). Twenty-plus common languages are supported — Python, JavaScript, TypeScript,
  HTML, CSS, JSON, Java, Kotlin, C/C++/C#, Go, Rust, Swift, Ruby, PHP, SQL, Bash, YAML,
  Markdown, and plain text — each highlighted with a light theme that also reads well in the
  exported PDF.
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
  cell data, and (in a tidied-up dialog with plain-language labels) whether to **shade the
  header row** and **shade every other row** (“zebra” stripes), plus grid-line colour, text
  colour, and alignment.
- **Rounded corners** — select a shape (rectangle, triangle, or diamond), image, video, or
  audio card and use the **⌜⌝ corner** field in the object bar to round its corners; the
  rounding follows the shape, so even a triangle or diamond gets softened points.
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
- **Rich text** — inside a text box you can mix **fonts, sizes, colours and styles**,
  add **bullet & numbered lists**, and insert **clickable links** (which stay clickable
  in the exported PDF). Formatting shows live as you type; `Ctrl/⌘-click` a link to open it.
  - **Links** — the 🔗 button opens a dialog with **Text** and **Link** fields you edit
    together: type a URL with the text empty and it fills the text for you; select text
    first and it becomes the link's text; existing links can be **edited or removed**.
    Typing a URL and pressing space/Enter still auto-links it — and the very next
    **Backspace undoes that auto-link** (press it again for a normal backspace).
  - **List markers** — bullets and numbers automatically **match the size, colour and
    style** of the text on their line; the **•⚙** button lets you nudge their size or
    colour if you want them a little different.
- **Audio & video** — the **➕ Insert** menu imports an audio/video file or **records** one
  with your mic/camera; it shows as a card you double-click to play. Clips are saved as
  real files under `NotadaMedia/` and streamed back (with seeking), so recorded video
  plays reliably rather than being embedded inline.
- **Shapes** — the **◇ Shape** menu drops a rectangle, circle/ellipse, triangle, diamond, or
  line; select it to change **fill, outline colour, outline width, width/height, and rotation**
  (drag the corners to resize proportionally, the sides to stretch one axis, the top handle to
  rotate). Or just **draw one freehand and hold the pen still** at the end — if your stroke is
  close to a basic shape it **snaps** to a clean one; a scribble stays as ink. Works with the
  **highlighter** too: a closed shape becomes a translucent highlight, a line a thick see-through mark.
- **Copy / paste objects** — select strokes, text, images (or a mix), `Ctrl/⌘+C` /
  `Ctrl/⌘+V` to duplicate them (paste selects the copy so you can move it), and drag a
  multi-selection's corner to **scale the whole group** proportionally. Screenshot paste
  and pasting into a text box still work as before.
- **Copy sizes & colours are per-tool** — pen and highlighter keep separate palettes and
  stroke-size lists; add/remove entries as you like.

## Install & run

You need **Python 3.11+** (developed on 3.14). Everything runs locally; no
internet is required after install.

### 1. Get the code and open a terminal in the project folder

The folder containing `manage.py`.

### 2. Create and activate a virtual environment

A virtual environment keeps Notada's dependencies separate from the rest of your
system. Create it once:

**Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```
> If PowerShell blocks the activate script, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then activate again.

**Windows (cmd.exe):**
```bat
python -m venv .venv
.venv\Scripts\activate.bat
```

**macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

You'll see `(.venv)` at the start of your prompt when it's active.

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Create the local database (first run only)

```bash
python manage.py migrate
```

### 5. Start the app

```bash
python manage.py runserver
```

Open **http://127.0.0.1:8000/** in your browser.

Next time, you only need steps 2 (activate the venv) and 5 (`runserver`). To stop
the server, press `Ctrl+C`. To leave the virtual environment, run `deactivate`.

> pdf.js, jsPDF, highlight.js and MathJax are vendored under
> `notes/static/notes/vendor/`, so PDF import/export, code highlighting and math
> all work fully offline — nothing is fetched from the internet at runtime.
> Recording audio/video and following links do use your browser's camera/mic and
> network respectively.

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

Three places, all local to this device:

1. **`db.sqlite3`** — the editable source of truth (pages, strokes, text, images).
   Back up your notes by copying this file.
2. **`NotadaPDFs/`** — the auto-generated, flattened PDF copies, laid out in
   folders matching your app folders. These are regenerated on every save.
3. **`NotadaMedia/`** — recorded/imported audio & video clips, stored as real files
   and streamed back to the player. The note references each clip by URL, so keep this
   folder alongside `db.sqlite3` when backing up.

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
