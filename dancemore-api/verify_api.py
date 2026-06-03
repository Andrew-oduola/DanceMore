"""One-shot API verification against a running dev server (http://localhost:8000)."""
import json
import urllib.error
import urllib.request

BASE = "http://localhost:8000/api"


def call(method, path, token=None, body=None, expect=200):
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as r:
            code, payload = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read() or b"{}")
    ok = "OK " if code == expect else "FAIL"
    print(f"[{ok}] {method} {path} -> {code} (expected {expect})")
    return code, payload


# 1. register a fresh user (delete-by-reregister not possible; use unique suffix)
import time
uname = f"smoke_{int(time.time())}"
_, tokens = call("POST", "/auth/register", body={"username": uname, "password": "pass1234"}, expect=201)
access = tokens["access"]

# duplicate register should 400
call("POST", "/auth/register", body={"username": uname, "password": "pass1234"}, expect=400)

# 2. login
_, tokens = call("POST", "/auth/login", body={"username": uname, "password": "pass1234"})
access = tokens["access"]

# bad login -> 401
call("POST", "/auth/login", body={"username": uname, "password": "wrong"}, expect=401)

# 3. unauthenticated access -> 401
call("GET", "/attempts", expect=401)
call("GET", "/stats", expect=401)

# 4. POST attempt
attempt = {
    "move_id": "side-step-reach",
    "move_name": "Side Step Reach",
    "overall_score": 77,
    "checkpoint_scores": [
        {"name": "Neutral", "score": 80},
        {"name": "Reach Right", "score": 74},
        {"name": "Reach Left", "score": 77},
    ],
}
call("POST", "/attempts", token=access, body=attempt, expect=201)
call("POST", "/attempts", token=access, body={**attempt, "overall_score": 85}, expect=201)

# 5. GET attempts — newest first, only mine
_, listing = call("GET", "/attempts", token=access)
scores = [a["overall_score"] for a in listing]
assert scores == [85, 77], f"expected newest-first [85, 77], got {scores}"
print(f"      attempts newest-first: {scores}  ✓")

# 6. stats for the smoke user
_, stats = call("GET", "/stats", token=access)
assert stats["total_attempts"] == 2, stats
assert stats["average_score"] == 81, stats
assert stats["current_streak"] == 1, stats  # both attempts today
assert len(stats["timeline"]) == 2 and stats["timeline"][0]["score"] == 77, stats
assert stats["moves"][0]["best_score"] == 85 and stats["moves"][0]["attempts"] == 2, stats
print(f"      stats: {json.dumps({k: v for k, v in stats.items() if k != 'timeline'})}  ✓")

# 7. demo user's seeded stats
_, tokens = call("POST", "/auth/login", body={"username": "demo", "password": "demo1234"})
_, stats = call("GET", "/stats", token=tokens["access"])
tl = stats["timeline"]
print(f"      demo: total={stats['total_attempts']} avg={stats['average_score']} streak={stats['current_streak']}")
print(f"      demo timeline: first={tl[0]} last={tl[-1]} points={len(tl)}")
print(f"      demo moves: {json.dumps(stats['moves'])}")
assert stats["current_streak"] == 24, f"expected 24-day streak, got {stats['current_streak']}"
assert tl[0]["score"] < 70 and tl[-1]["score"] > 80, "trend should climb 60s -> mid-80s"
chrono = [p["date"] for p in tl]
assert chrono == sorted(chrono), "timeline must be chronological"

# 8. isolation: smoke user must not see demo attempts
_, listing = call("GET", "/attempts", token=access)
assert len(listing) == 2, f"user isolation broken: {len(listing)}"
print("      per-user isolation ✓")

print("\nALL CHECKS PASSED")
