"""Streak edge-case checks, run via: manage.py shell < verify_streak.py
Creates throwaway users with backdated attempts and asserts the streak rule:
consecutive days up to today; today empty -> count up to yesterday; yesterday
also empty -> 0.
"""
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import Client
from django.utils import timezone

from training.models import Attempt

CASES = [
    # (name, day-offsets with attempts, expected streak)
    ("streak_today_only", [0], 1),
    ("streak_yesterday_only", [1], 1),          # today empty -> counts up to yesterday
    ("streak_two_days_ago", [2], 0),            # yesterday empty -> 0
    ("streak_run_with_today", [0, 1, 2], 3),
    ("streak_run_no_today", [1, 2, 3], 3),      # unbroken run ending yesterday
    ("streak_gap", [0, 1, 3, 4], 2),            # gap at day-2 stops the count
    ("streak_none", [], 0),
]

now = timezone.now().replace(hour=12, minute=0, second=0, microsecond=0)
client = Client()
failures = 0

for name, offsets, expected in CASES:
    User.objects.filter(username=name).delete()
    user = User.objects.create_user(username=name, password="x")
    for off in offsets:
        a = Attempt.objects.create(
            user=user, move_id="m", move_name="M", overall_score=70,
            checkpoint_scores=[],
        )
        Attempt.objects.filter(pk=a.pk).update(created_at=now - timedelta(days=off))
    client.force_login(user)
    # Call the view directly with session auth off — use force_authenticate via DRF
    from rest_framework.test import APIRequestFactory, force_authenticate
    from training.views import StatsView
    req = APIRequestFactory().get("/api/stats")
    force_authenticate(req, user=user)
    streak = StatsView.as_view()(req).data["current_streak"]
    status = "OK " if streak == expected else "FAIL"
    if streak != expected:
        failures += 1
    print(f"[{status}] {name}: offsets={offsets} -> streak={streak} (expected {expected})")
    user.delete()

print("ALL STREAK CHECKS PASSED" if failures == 0 else f"{failures} FAILURES")
