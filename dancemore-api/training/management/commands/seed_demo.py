import random
from datetime import timedelta

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from django.utils import timezone

from training.models import Attempt

DEMO_USERNAME = "demo"
DEMO_PASSWORD = "demo1234"

# Matches the 3 moves shipped in dancemore-spike/public/moves.json.
MOVES = [
    ("side-step-reach", "Side Step Reach", ["Neutral", "Reach Right", "Reach Left"]),
    ("arms-up-bounce", "Arms Up Bounce", ["Arms Down", "Arms Up"]),
    ("knee-lift-march", "Knee Lift March", ["Stand", "Left Knee Up", "Right Knee Up"]),
]

DAYS = 24  # ~3.5 weeks of consecutive practice, ending today


class Command(BaseCommand):
    help = "Create/reset the 'demo' account with ~3-4 weeks of upward-trending attempts."

    def handle(self, *args, **options):
        rng = random.Random(42)  # deterministic so reseeds look the same

        # Wipe and reseed cleanly if run twice.
        User.objects.filter(username=DEMO_USERNAME).delete()  # cascades to attempts
        user = User.objects.create_user(
            username=DEMO_USERNAME, password=DEMO_PASSWORD
        )

        now = timezone.now().replace(hour=18, minute=0, second=0, microsecond=0)
        created = 0

        # Oldest day first so the score trend climbs over time.
        for offset in range(DAYS - 1, -1, -1):
            progress = (DAYS - 1 - offset) / (DAYS - 1)  # 0.0 (oldest) -> 1.0 (today)
            base = 62 + progress * 24  # ~62 climbing to ~86

            # 1-2 attempts per day, every day, for a healthy unbroken streak.
            for n in range(rng.choice([1, 1, 2])):
                move_id, move_name, checkpoints = MOVES[(offset + n) % len(MOVES)]
                cp_scores = []
                for cp in checkpoints:
                    s = int(round(base + rng.uniform(-6, 6)))
                    s = max(0, min(100, s))
                    cp_scores.append({"name": cp, "score": s})
                overall = round(sum(c["score"] for c in cp_scores) / len(cp_scores))

                attempt = Attempt.objects.create(
                    user=user,
                    move_id=move_id,
                    move_name=move_name,
                    overall_score=overall,
                    checkpoint_scores=cp_scores,
                )
                # auto_now_add forces created_at on insert; backdate via update().
                ts = now - timedelta(days=offset, minutes=n * 90)
                Attempt.objects.filter(pk=attempt.pk).update(created_at=ts)
                created += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded '{DEMO_USERNAME}' / '{DEMO_PASSWORD}' with {created} "
                f"attempts across {DAYS} days."
            )
        )
