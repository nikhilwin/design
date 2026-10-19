import pytest
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_health_endpoint():
    res = APIClient().get("/api/v1/health/")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
