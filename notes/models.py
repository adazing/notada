import json

from django.db import models


class Folder(models.Model):
    """A named folder. Folders can nest arbitrarily via ``parent``.

    The folder tree is also mirrored as real directories on disk (under
    ``settings.NOTES_PDF_ROOT``) where each note's PDF copy is written.
    """

    name = models.CharField(max_length=200)
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        related_name="children",
        on_delete=models.CASCADE,
    )
    color = models.CharField(max_length=20, default="#6c8cff")
    order = models.IntegerField(default=0)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["order", "name"]

    def __str__(self):
        return self.name

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "parent_id": self.parent_id,
            "color": self.color,
            "order": self.order,
            "children": [c.to_dict() for c in self.children.all()],
            "note_count": self.notes.count(),
        }


# A fresh note starts with a single blank A4-ish page (96 dpi CSS pixels).
BLANK_DOC = {
    "pages": [
        {"id": "p1", "width": 794, "height": 1123, "background": None, "objects": []}
    ]
}


class Note(models.Model):
    """A single note.

    There is no longer a typed-vs-handwritten split: every note is one unified
    document (``doc``) of pages, where each page holds a mix of freehand
    strokes, text boxes and images. ``doc`` is the editable source of truth;
    a flattened PDF copy is written to disk on every save (``pdf_path``).
    """

    folder = models.ForeignKey(
        Folder, related_name="notes", on_delete=models.CASCADE
    )
    title = models.CharField(max_length=300, default="Untitled note")

    # The full editable canvas document, stored as JSON text.
    doc = models.TextField(blank=True, default="")

    color = models.CharField(max_length=20, default="#5b7cfa")
    pinned = models.BooleanField(default=False)

    # Absolute path of the auto-generated PDF copy on disk (may be blank until
    # the first PDF is written).
    pdf_path = models.CharField(max_length=1000, blank=True, default="")

    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-pinned", "-updated"]

    def __str__(self):
        return self.title

    def get_doc(self):
        try:
            data = json.loads(self.doc) if self.doc else None
        except json.JSONDecodeError:
            data = None
        if not data or "pages" not in data or not data["pages"]:
            return json.loads(json.dumps(BLANK_DOC))
        return data

    def page_count(self):
        return len(self.get_doc().get("pages", []))

    def to_dict(self, include_doc=False):
        data = {
            "id": self.id,
            "folder_id": self.folder_id,
            "title": self.title,
            "color": self.color,
            "pinned": self.pinned,
            "pages": self.page_count(),
            "created": self.created.isoformat(),
            "updated": self.updated.isoformat(),
        }
        if include_doc:
            data["doc"] = self.get_doc()
        return data
