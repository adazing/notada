import json
from pathlib import Path

from django.conf import settings
from django.db.models import Q
from django.db.models.functions import Lower
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.utils.text import slugify
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from .models import BLANK_DOC, Folder, Note


def index(request):
    """The single-page canvas app shell."""
    return render(request, "notes/index.html")


def _body(request):
    try:
        return json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return {}


# ---------------------------------------------------------------------------
# On-disk PDF locations (mirror the folder tree)
# ---------------------------------------------------------------------------

def _folder_path_parts(folder):
    parts = []
    while folder is not None:
        # Append the folder id so that two folders sharing a name (even as
        # siblings) never map to the same directory on disk.
        parts.append(f"{slugify(folder.name) or 'folder'}-{folder.id}")
        folder = folder.parent
    parts.reverse()
    return parts


def _note_pdf_path(note):
    root = Path(settings.NOTES_PDF_ROOT)
    directory = root.joinpath(*_folder_path_parts(note.folder))
    directory.mkdir(parents=True, exist_ok=True)
    name = (slugify(note.title) or "note") + f"-{note.id}.pdf"
    return directory / name


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

@require_http_methods(["GET", "POST"])
def folders(request):
    if request.method == "GET":
        roots = Folder.objects.filter(parent__isnull=True)
        return JsonResponse({"folders": [f.to_dict() for f in roots]})

    data = _body(request)
    name = (data.get("name") or "").strip() or "New folder"
    parent_id = data.get("parent_id")
    parent = Folder.objects.filter(id=parent_id).first() if parent_id else None
    folder = Folder.objects.create(
        name=name, parent=parent, color=data.get("color", "#6c8cff")
    )
    return JsonResponse(folder.to_dict(), status=201)


@require_http_methods(["PATCH", "DELETE"])
def folder_detail(request, pk):
    folder = get_object_or_404(Folder, pk=pk)

    if request.method == "DELETE":
        folder.delete()
        return JsonResponse({"ok": True})

    data = _body(request)
    if "name" in data:
        folder.name = (data["name"] or "").strip() or folder.name
    if "color" in data:
        folder.color = data["color"]
    if "parent_id" in data:
        new_parent_id = data["parent_id"]
        if new_parent_id and not _is_descendant(new_parent_id, folder.id):
            folder.parent_id = new_parent_id
        elif not new_parent_id:
            folder.parent_id = None
    folder.save()
    return JsonResponse(folder.to_dict())


def _is_descendant(candidate_id, folder_id):
    current = Folder.objects.filter(id=candidate_id).first()
    while current is not None:
        if current.id == folder_id:
            return True
        current = current.parent
    return False


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------

@require_http_methods(["GET", "POST"])
def notes(request):
    if request.method == "GET":
        qs = Note.objects.all()
        search = (request.GET.get("q") or "").strip()
        if search:
            # Search matches the title, the note's contents (text boxes, code,
            # sticky notes — all live in `doc`), or the folder's name. Searching
            # spans every folder, not just the current one.
            qs = qs.filter(
                Q(title__icontains=search)
                | Q(doc__icontains=search)
                | Q(folder__name__icontains=search)
            ).distinct()
        else:
            folder_id = request.GET.get("folder")
            if folder_id:
                qs = qs.filter(folder_id=folder_id)

        allowed_sorts = {"-updated", "updated", "-created", "created", "title", "-title"}
        sort = request.GET.get("sort") or "-updated"
        if sort not in allowed_sorts:
            sort = "-updated"
        if sort == "title":
            qs = qs.order_by("-pinned", Lower("title"))
        elif sort == "-title":
            qs = qs.order_by("-pinned", Lower("title").desc())
        else:
            qs = qs.order_by("-pinned", sort)
        return JsonResponse({"notes": [n.to_dict() for n in qs]})

    data = _body(request)
    folder = get_object_or_404(Folder, pk=data.get("folder_id"))
    note = Note.objects.create(
        folder=folder,
        title=(data.get("title") or "Untitled note").strip(),
        color=data.get("color", "#5b7cfa"),
        doc=json.dumps(BLANK_DOC),
    )
    return JsonResponse(note.to_dict(include_doc=True), status=201)


@require_http_methods(["GET", "PATCH", "DELETE"])
def note_detail(request, pk):
    note = get_object_or_404(Note, pk=pk)

    if request.method == "GET":
        return JsonResponse(note.to_dict(include_doc=True))

    if request.method == "DELETE":
        # remove the on-disk PDF copy too
        if note.pdf_path:
            try:
                Path(note.pdf_path).unlink(missing_ok=True)
            except OSError:
                pass
        note.delete()
        return JsonResponse({"ok": True})

    data = _body(request)
    if "title" in data:
        note.title = (data["title"] or "Untitled note").strip()
    if "color" in data:
        note.color = data["color"]
    if "pinned" in data:
        note.pinned = bool(data["pinned"])
    if "folder_id" in data and data["folder_id"]:
        note.folder_id = data["folder_id"]
    if "doc" in data:
        note.doc = json.dumps(data["doc"])
    note.save()
    return JsonResponse(note.to_dict(include_doc="doc" in data))


# ---------------------------------------------------------------------------
# PDF: auto-save to disk (POST raw bytes) + download (GET)
# ---------------------------------------------------------------------------

@csrf_protect
@require_http_methods(["POST", "GET"])
def note_pdf(request, pk):
    note = get_object_or_404(Note, pk=pk)

    if request.method == "GET":
        if not note.pdf_path or not Path(note.pdf_path).exists():
            raise Http404("No PDF has been generated for this note yet.")
        filename = (slugify(note.title) or "note") + ".pdf"
        return FileResponse(
            open(note.pdf_path, "rb"),
            as_attachment=True,
            filename=filename,
            content_type="application/pdf",
        )

    # POST: the browser sends the generated PDF bytes as the raw request body.
    pdf_bytes = request.body
    if not pdf_bytes:
        return JsonResponse({"error": "empty body"}, status=400)

    target = _note_pdf_path(note)

    # If the note moved/was renamed, clean up the previous file.
    old = note.pdf_path
    if old and Path(old) != target:
        try:
            Path(old).unlink(missing_ok=True)
        except OSError:
            pass

    target.write_bytes(pdf_bytes)
    note.pdf_path = str(target)
    note.save(update_fields=["pdf_path"])
    return JsonResponse({"ok": True, "path": str(target)})


def export_json(request, pk):
    note = get_object_or_404(Note, pk=pk)
    payload = json.dumps(note.to_dict(include_doc=True), indent=2)
    resp = HttpResponse(payload, content_type="application/json")
    safe = (slugify(note.title) or "note")
    resp["Content-Disposition"] = f'attachment; filename="{safe}.json"'
    return resp
