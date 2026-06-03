from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView

from .views import AttemptListCreateView, RegisterView, StatsView

urlpatterns = [
    path("auth/register", RegisterView.as_view(), name="register"),
    path("auth/login", TokenObtainPairView.as_view(), name="login"),
    path("attempts", AttemptListCreateView.as_view(), name="attempts"),
    path("stats", StatsView.as_view(), name="stats"),
]
