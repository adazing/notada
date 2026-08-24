from django.urls import path

from . import views

urlpatterns = [
    path("", views.index, name="index"),
    path("api/folders/", views.folders, name="folders"),
    path("api/folders/reorder/", views.folders_reorder, name="folders-reorder"),
    path("api/folders/<int:pk>/", views.folder_detail, name="folder-detail"),
    path("api/notes/", views.notes, name="notes"),
    path("api/notes/<int:pk>/", views.note_detail, name="note-detail"),
    path("api/notes/<int:pk>/pdf/", views.note_pdf, name="note-pdf"),
    path("api/notes/<int:pk>/export/json/", views.export_json, name="export-json"),
    path("api/media/", views.media_upload, name="media-upload"),
    path("api/media/<str:name>", views.media_serve, name="media-serve"),
]
