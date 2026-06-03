# dancemore-api

Django + DRF backend for DanceMore: JWT auth, attempt persistence, and dashboard stats. SQLite locally (Neon/Postgres comes at deploy time).

## Run

```bash
venv\Scripts\activate          # Windows (or: source venv/bin/activate)
python manage.py migrate
python manage.py seed_demo      # creates demo / demo1234 with ~3.5 weeks of attempts
python manage.py runserver 8000
```

The frontend (`../dancemore-spike`, `npm run dev`) expects this on `http://localhost:8000` (see its `.env.local` → `NEXT_PUBLIC_API_URL`).

## Endpoints (all under `/api/`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | public | `{username, password}` → `{access, refresh}` |
| POST | `/api/auth/login` | public | SimpleJWT token pair |
| POST | `/api/attempts` | Bearer | save an attempt |
| GET | `/api/attempts` | Bearer | current user's attempts, newest first |
| GET | `/api/stats` | Bearer | totals, average, streak, timeline, per-move bests |

## Verification scripts

With the server running:

- `python verify_api.py` — end-to-end API smoke test (register/login/401s/attempts/stats/demo seed/user isolation).
- `python manage.py shell < verify_streak.py` — streak edge cases across day boundaries.
