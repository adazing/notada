"""
Django settings for Notada — a local, single-device note-taking app.

There are no user accounts: this app is meant to be run locally on your own
machine, so the database itself (SQLite, stored next to this project) is the
"local storage" on your device. Nothing is sent anywhere.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# A fixed key is fine here: this app only ever runs locally on your own device,
# with no accounts and no network exposure.
SECRET_KEY = "notada-local-only-not-a-secret-run-on-your-own-device"

# Handy while running locally so you can see full error pages.
DEBUG = True

# Local use only.
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "notes",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "notada.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
            ],
        },
    },
]

WSGI_APPLICATION = "notada.wsgi.application"

# The SQLite file lives right next to the project — this is your local,
# on-device store. Back it up by copying db.sqlite3.
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"

# Notes can embed large base64 images/handwriting; raise the request size cap.
DATA_UPLOAD_MAX_MEMORY_SIZE = 100 * 1024 * 1024  # 100 MB

# Where auto-generated PDF copies of your notes are written on this device.
# The folder tree here mirrors your folders in the app. This is the "saved on
# device" location — back it up by copying this folder.
NOTES_PDF_ROOT = BASE_DIR / "NotadaPDFs"

# Where recorded/imported audio & video clips are stored as real files (served
# back over HTTP so <video>/<audio> can play and seek them reliably — data: URLs
# are not dependable for video). Like the PDFs, these live on your device.
NOTES_MEDIA_ROOT = BASE_DIR / "NotadaMedia"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
