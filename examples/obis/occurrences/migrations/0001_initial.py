from typing import ClassVar

from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies: ClassVar[list] = []
    operations: ClassVar[list] = [
        migrations.CreateModel(
            name="Occurrence",
            fields=[
                ("id", models.CharField(max_length=255, primary_key=True, serialize=False)),
                ("lon", models.FloatField()),
                ("lat", models.FloatField()),
                ("depth", models.FloatField()),
                ("date", models.DateField()),
                ("name", models.TextField()),
            ],
        ),
    ]
