from django.db import models


class Occurrence(models.Model):
    id = models.CharField(primary_key=True, max_length=255)
    lon = models.FloatField()
    lat = models.FloatField()
    depth = models.FloatField()
    date = models.DateField()
    name = models.TextField()
