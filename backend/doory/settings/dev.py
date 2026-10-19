from .base import *

DEBUG = True
ALLOWED_HOSTS = ["*"]

# `manage.py runserver` serves WebSockets (real-time co-editing) when daphne comes first.
INSTALLED_APPS = ["daphne", *INSTALLED_APPS]
