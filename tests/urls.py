from django.urls import path

from samplesift.django.api import api

urlpatterns = [path("samplesift/", api.urls)]
