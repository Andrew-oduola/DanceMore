from django.conf import settings
from django.db import models


class Attempt(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="attempts",
    )
    move_id = models.CharField(max_length=100)
    move_name = models.CharField(max_length=200)
    overall_score = models.IntegerField()
    checkpoint_scores = models.JSONField()  # [{"name": "Pose 1", "score": 83}, ...]
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user} · {self.move_name} · {self.overall_score}"
