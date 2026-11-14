from pathlib import Path

import pytest

from app import create_app


@pytest.fixture
def client(tmp_path):
    application = create_app({
        "TESTING": True,
        "SECRET_KEY": "testing-secret-key",
        "DATABASE": str(tmp_path / "test.sqlite3"),
        "DATA_DIR": Path(__file__).resolve().parents[1] / "data",
    })
    return application.test_client()


def csrf(client):
    client.get("/")
    with client.session_transaction() as sess:
        return sess["csrf_token"]


def forecast(client, **changes):
    payload = {"route": "MOW-AER", "date": "2026-06-01", "price": 9000}
    payload.update(changes)
    return client.post("/api/forecast", json=payload, headers={"X-CSRF-Token": csrf(client)})


def test_homepage_and_health(client):
    assert client.get("/").status_code == 200
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json == {"status": "ok", "routes": 5, "flights": 155}


def test_median_at_base_price(client):
    response = forecast(client)
    assert response.status_code == 200
    data = response.json
    assert data["demand"] == 800
    assert data["sales"] == 800
    assert data["remaining_seats"] == 100
    assert data["seats"] == 900
    assert len(data["scenarios"]) == 9
    assert data["scenarios"][4]["demand"] == data["demand"]
    assert data["scenarios"][4]["sales"] == data["sales"]


def test_price_sensitivity_and_capacity(client):
    response = forecast(client, price=10000)
    assert response.status_code == 200
    data = response.json
    assert data["demand"] == 659
    assert data["sales"] == 659
    assert data["remaining_seats"] == 241
    for scenario in data["scenarios"]:
        assert 0 <= scenario["sales"] <= data["seats"]


def test_price_bounds_and_date(client):
    assert forecast(client, price=5000).status_code == 400
    assert forecast(client, price=20000).status_code == 400
    assert forecast(client, date="2026-05-31").status_code == 404
    assert forecast(client, date="wrong").status_code == 400
    assert forecast(client, route="BAD").status_code == 400
    assert forecast(client, price=float("inf")).status_code == 400


def test_csrf_protection(client):
    client.get("/")
    response = client.post("/api/forecast", json={"route": "MOW-AER", "date": "2026-06-01", "price": 9000})
    assert response.status_code == 403


def test_registration_login_and_history(client):
    token = csrf(client)
    registration = client.post("/register", data={
        "csrf_token": token,
        "name": "Тестовый пользователь",
        "email": "test@example.com",
        "password": "secure-password-123",
        "password_again": "secure-password-123",
    })
    assert registration.status_code == 302
    login = client.post("/login", data={
        "csrf_token": csrf(client),
        "email": "test@example.com",
        "password": "secure-password-123",
    })
    assert login.status_code == 302
    assert forecast(client, save_history=True).status_code == 200
    page = client.get("/history")
    assert page.status_code == 200
    assert "Москва — Сочи".encode() in page.data
    logout = client.post("/logout", data={"csrf_token": csrf(client)})
    assert logout.status_code == 302
    assert client.get("/history").status_code == 302


def test_theme_toggle_on_pages(client):
    for path in ("/", "/login", "/register"):
        response = client.get(path)
        assert response.status_code == 200
        assert b'id="theme-toggle"' in response.data
        assert b'js/theme.js' in response.data
    assert client.get("/static/js/theme.js").status_code == 200


def test_price_timeline_and_nine_scenarios(client):
    response = forecast(client, date="2026-06-12")
    assert response.status_code == 200
    data = response.json
    assert len(data["scenarios"]) == 9
    assert len(data["price_timeline"]) == 31
    assert data["price_timeline"][0]["date"] == "2026-06-01"
    assert data["price_timeline"][-1]["date"] == "2026-07-01"
    selected = next(item for item in data["price_timeline"] if item["date"] == "2026-06-12")
    assert len(selected["prices"]) == 9
    assert selected["prices"]["0.5"] == data["scenarios"][4]["optimal_price"]
    assert selected["prices"]["0.9"] > selected["prices"]["0.1"]


def test_price_timeline_uses_model_values_and_not_user_price(client):
    first = forecast(client, route="MOW-LED", price=5500).json
    second = forecast(client, route="MOW-LED", price=6000).json
    assert first["price_timeline"] == second["price_timeline"]
    assert first["demand"] != second["demand"]
    assert first["price_timeline"][0]["prices"]["0.1"] == 5775


def test_homepage_autoupdate_without_calculate_button(client):
    page = client.get("/")
    assert page.status_code == 200
    assert b'id="calculate-btn"' not in page.data
    script = client.get("/static/js/app.js")
    assert script.status_code == 200
    assert b'scheduleCalculate(0, false)' in script.data
    assert b'priceInput.addEventListener("input", () => scheduleCalculate(250))' in script.data
