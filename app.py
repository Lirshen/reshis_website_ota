import csv
import hmac
import math
import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, abort, flash, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
QUANTILES = [f"0.{i}" for i in range(1, 10)]


def load_csv_data(data_dir):
    with (data_dir / "routes.csv").open(encoding="utf-8-sig", newline="") as f:
        routes = {}
        for item in csv.DictReader(f):
            routes[item["route"]] = {
                "route": item["route"],
                "name": item["name"],
                "base_price": float(item["base_price"]),
                "price_min": float(item["price_min"]),
                "price_max": float(item["price_max"]),
                "price_sensitivity": float(item["price_sensitivity"]),
                "cost_per_passenger": float(item["cost_per_passenger"]),
            }

    with (data_dir / "my_forecast.csv").open(encoding="utf-8-sig", newline="") as f:
        forecasts = {}
        for item in csv.DictReader(f):
            key = (item["route"], item["date"])
            if key in forecasts:
                raise ValueError(f"Повторяющийся рейс: {key}")
            if key[0] not in routes:
                raise ValueError(f"Маршрут отсутствует в routes.csv: {key[0]}")
            forecasts[key] = {
                "seats": int(item["seats"]),
                "base_demand": {q: float(item[f"{q}_base_demand"]) for q in QUANTILES},
                "optimal_price": {q: float(item[f"{q}_price"]) for q in QUANTILES},
            }
    if not routes or not forecasts:
        raise ValueError("CSV-файлы не должны быть пустыми")
    return routes, forecasts


def get_db():
    if "db" not in g:
        db_path = Path(g.app_config_database)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        g.db = sqlite3.connect(db_path, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS forecast_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            route TEXT NOT NULL,
            flight_date TEXT NOT NULL,
            price REAL NOT NULL,
            demand REAL NOT NULL,
            sales REAL NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    """)
    db.commit()


def calculate_forecast(route, flight, price):
    seats = flight["seats"]
    b = route["price_sensitivity"]
    base_price = route["base_price"]
    scenarios = []
    for q in QUANTILES:
        demand = flight["base_demand"][q] - b * (price - base_price)
        sales = min(seats, max(0.0, demand))
        scenarios.append({
            "quantile": q,
            "probability": int(float(q) * 100),
            "demand": round(demand, 2),
            "sales": round(sales, 2),
            "optimal_price": flight["optimal_price"][q],
        })
    median = scenarios[4]
    return {
        "route": route["route"],
        "route_name": route["name"],
        "seats": seats,
        "price": price,
        "base_price": base_price,
        "price_min": route["price_min"],
        "price_max": route["price_max"],
        "price_sensitivity": b,
        "demand": median["demand"],
        "sales": median["sales"],
        "remaining_seats": round(seats - median["sales"], 2),
        "load_percent": round(100 * median["sales"] / seats, 2) if seats else 0,
        "optimal_price": median["optimal_price"],
        "scenarios": scenarios,
    }


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
        DATABASE=os.environ.get("DATABASE_PATH") or str(ROOT / "instance" / "reshis_avia.sqlite3"),
        DATA_DIR=ROOT / "data",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
        MAX_CONTENT_LENGTH=16 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    routes, forecasts = load_csv_data(Path(app.config["DATA_DIR"]))
    available_dates = sorted({day for _, day in forecasts})

    @app.before_request
    def prepare_request():
        g.app_config_database = app.config["DATABASE"]
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)

    app.teardown_appcontext(close_db)

    with app.app_context():
        g.app_config_database = app.config["DATABASE"]
        init_db()

    def current_user():
        if "user" not in g:
            user_id = session.get("user_id")
            g.user = get_db().execute("SELECT id, name, email FROM users WHERE id = ?", (user_id,)).fetchone() if user_id else None
        return g.user

    def csrf_valid():
        submitted = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
        expected = session.get("csrf_token", "")
        return bool(submitted and expected and hmac.compare_digest(submitted, expected))

    def login_required(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if not current_user():
                flash("Войдите в аккаунт, чтобы открыть историю расчётов.", "info")
                return redirect(url_for("login"))
            return view(*args, **kwargs)
        return wrapped

    @app.context_processor
    def inject_globals():
        return {"current_user": current_user(), "csrf_token": session.get("csrf_token", "")}

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        return render_template("index.html", routes=list(routes.values()), min_date=available_dates[0], max_date=available_dates[-1], total_flights=len(forecasts))

    @app.post("/api/forecast")
    def api_forecast():
        if not csrf_valid():
            return jsonify({"error": "Сессия устарела. Обновите страницу и повторите попытку."}), 403
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Ожидаются данные в формате JSON."}), 400
        route_id = payload.get("route")
        flight_date = payload.get("date")
        price = payload.get("price")
        if not isinstance(route_id, str) or route_id not in routes:
            return jsonify({"error": "Выберите маршрут из списка."}), 400
        if not isinstance(flight_date, str):
            return jsonify({"error": "Укажите дату вылета."}), 400
        try:
            if datetime.strptime(flight_date, "%Y-%m-%d").strftime("%Y-%m-%d") != flight_date:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "Неверный формат даты."}), 400
        if (route_id, flight_date) not in forecasts:
            return jsonify({"error": "Для этой даты и маршрута прогноз отсутствует."}), 404
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
            return jsonify({"error": "Введите корректную цену билета."}), 400
        route = routes[route_id]
        if not route["price_min"] <= price <= route["price_max"]:
            return jsonify({"error": f"Для этого маршрута допустима цена от {route['price_min']:,.0f} до {route['price_max']:,.0f} ₽.".replace(",", " ")}), 400

        result = calculate_forecast(route, forecasts[(route_id, flight_date)], float(price))
        result["date"] = flight_date
        result["price_timeline"] = [
            {
                "date": day,
                "prices": {q: forecasts[(route_id, day)]["optimal_price"][q] for q in QUANTILES},
            }
            for day in available_dates if (route_id, day) in forecasts
        ]
        if current_user() and payload.get("save_history") is True:
            db = get_db()
            db.execute(
                "INSERT INTO forecast_history (user_id, route, flight_date, price, demand, sales, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (g.user["id"], route_id, flight_date, price, result["demand"], result["sales"], datetime.now(timezone.utc).isoformat(timespec="seconds")),
            )
            db.commit()
        return jsonify(result)

    @app.route("/register", methods=["GET", "POST"])
    def register():
        if current_user():
            return redirect(url_for("index"))
        if request.method == "POST":
            if not csrf_valid():
                abort(403)
            name = request.form.get("name", "").strip()
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            password_again = request.form.get("password_again", "")
            if not 2 <= len(name) <= 60:
                flash("Имя должно содержать от 2 до 60 символов.", "error")
            elif not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
                flash("Введите корректный адрес электронной почты.", "error")
            elif not 8 <= len(password) <= 128:
                flash("Пароль должен содержать от 8 до 128 символов.", "error")
            elif password != password_again:
                flash("Пароли не совпадают.", "error")
            else:
                try:
                    db = get_db()
                    db.execute(
                        "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                        (name, email, generate_password_hash(password), datetime.now(timezone.utc).isoformat(timespec="seconds")),
                    )
                    db.commit()
                    flash("Аккаунт создан. Теперь войдите в систему.", "success")
                    return redirect(url_for("login"))
                except sqlite3.IntegrityError:
                    flash("Этот адрес электронной почты уже зарегистрирован.", "error")
        return render_template("register.html")

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if current_user():
            return redirect(url_for("index"))
        if request.method == "POST":
            if not csrf_valid():
                abort(403)
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            user = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if not user or not check_password_hash(user["password_hash"], password):
                flash("Неверная почта или пароль.", "error")
            else:
                session.clear()
                session["user_id"] = user["id"]
                session["csrf_token"] = secrets.token_urlsafe(32)
                flash("Вы вошли в аккаунт.", "success")
                return redirect(url_for("index"))
        return render_template("login.html")

    @app.post("/logout")
    def logout():
        if not csrf_valid():
            abort(403)
        session.clear()
        flash("Вы вышли из аккаунта.", "info")
        return redirect(url_for("index"))

    @app.get("/history")
    @login_required
    def history():
        entries = get_db().execute(
            "SELECT route, flight_date, price, demand, sales, created_at FROM forecast_history WHERE user_id = ? ORDER BY id DESC LIMIT 30",
            (g.user["id"],),
        ).fetchall()
        return render_template("history.html", entries=entries, routes=routes)

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "routes": len(routes), "flights": len(forecasts)})

    @app.errorhandler(404)
    def not_found(_error):
        return render_template("404.html"), 404

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=int(os.environ.get("PORT", 5000)))
