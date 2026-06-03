from datetime import timedelta

from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import Attempt
from .serializers import AttemptSerializer, RegisterSerializer


def _tokens_for(user):
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(_tokens_for(user), status=status.HTTP_201_CREATED)


class AttemptListCreateView(generics.ListCreateAPIView):
    serializer_class = AttemptSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        # Model Meta already orders newest-first.
        return Attempt.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class StatsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        # Chronological order for the timeline.
        attempts = list(
            Attempt.objects.filter(user=request.user).order_by("created_at")
        )

        total = len(attempts)
        if total == 0:
            return Response(
                {
                    "total_attempts": 0,
                    "average_score": 0,
                    "current_streak": 0,
                    "timeline": [],
                    "moves": [],
                }
            )

        avg = round(sum(a.overall_score for a in attempts) / total)

        # Local date per attempt (respects settings.TIME_ZONE).
        def local_date(dt):
            return timezone.localdate(dt)

        timeline = [
            {"date": local_date(a.created_at).isoformat(), "score": a.overall_score}
            for a in attempts
        ]

        # current_streak: consecutive calendar days up to today with >=1 attempt.
        days = {local_date(a.created_at) for a in attempts}
        today = timezone.localdate()
        day = today if today in days else today - timedelta(days=1)
        streak = 0
        while day in days:
            streak += 1
            day -= timedelta(days=1)

        # Per-move best score + attempt count.
        moves = {}
        for a in attempts:
            m = moves.get(a.move_id)
            if m is None:
                moves[a.move_id] = {
                    "move_id": a.move_id,
                    "move_name": a.move_name,
                    "best_score": a.overall_score,
                    "attempts": 1,
                }
            else:
                m["best_score"] = max(m["best_score"], a.overall_score)
                m["attempts"] += 1
                m["move_name"] = a.move_name  # keep latest seen name

        return Response(
            {
                "total_attempts": total,
                "average_score": avg,
                "current_streak": streak,
                "timeline": timeline,
                "moves": list(moves.values()),
            }
        )
