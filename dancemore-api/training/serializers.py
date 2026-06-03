from django.contrib.auth.models import User
from rest_framework import serializers

from .models import Attempt


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=4)

    class Meta:
        model = User
        fields = ["username", "password"]

    def create(self, validated_data):
        return User.objects.create_user(
            username=validated_data["username"],
            password=validated_data["password"],
        )


class AttemptSerializer(serializers.ModelSerializer):
    class Meta:
        model = Attempt
        fields = [
            "id",
            "move_id",
            "move_name",
            "overall_score",
            "checkpoint_scores",
            "created_at",
        ]
        read_only_fields = ["id", "created_at"]
