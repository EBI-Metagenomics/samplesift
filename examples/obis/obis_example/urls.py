from django.urls import path
from django.views.generic import TemplateView

from samplesift.django.api import api

urlpatterns = [
    path("", TemplateView.as_view(template_name="occurrences/index.html")),
    path("samplesift/", api.urls),
]
