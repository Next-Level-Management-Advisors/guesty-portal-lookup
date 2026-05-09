#!/usr/bin/env python3
"""Pre-publish the Guesty guest-app runtime for all currently-unprovisioned
upcoming reservations.

Mechanism: posting an internal `module: {type: "note"}` post containing the
literal `{{guest_app::<slug>}}` merge tag to the reservation's conversation
causes Guesty to render the tag server-side. As a side effect of rendering,
Guesty publishes the per-reservation guest-app runtime (within ~15s).
The note is internal-only — guests never see it.

Endpoint: POST /v1/communication/conversations/<id>/send-message
Body:     {"body": "{{guest_app::<slug>}}", "module": {"type": "note"}}

Usage:
  python3 prepublish-guest-app.py [--dry] [--limit N] [--slug fidum_company]
                                  [--skip-already-noted]
"""
import argparse
import base64
import glob
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

OPEN_API = "https://open-api.guesty.com/v1"
GUEST_APP = "https://guest-app.guesty.com"
RUNTIME_POLL_DELAYS = (5, 5, 10, 10)  # cumulative ~30s


def http(method, url, *, token=None, body=None):
    h = {"Accept": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]


def get_token():
    files = sorted(
        glob.glob(os.path.join(tempfile.gettempdir(), "guesty-open-api-token-*.json"))
        + glob.glob("/tmp/guesty-open-api-token-*.json")
    )
    now_ms = time.time() * 1000
    for f in files:
        try:
            d = json.load(open(f))
            if d.get("expires_at", 0) > now_ms + 60_000:
                return d["access_token"]
        except FileNotFoundError:
            continue
    raise SystemExit("No valid cached Open API token found.")


def runtime_status(reservation_id, dynamic_var):
    code, login = http(
        "POST",
        f"{GUEST_APP}/api/public/guest-app-auth/login",
        body={"reservationId": reservation_id, "dynamicVar": dynamic_var},
    )
    if code not in (200, 201) or not isinstance(login, dict):
        return None
    jwt = login.get("token")
    if not jwt:
        return None
    rt_url = f"{GUEST_APP}/api/public/guest-app-runtime/initial-data/{urllib.parse.quote(reservation_id)}/{urllib.parse.quote(dynamic_var)}"
    rt_code, _ = http("GET", rt_url, token=jwt)
    return rt_code


def find_conversation(token, reservation_id):
    qs = urllib.parse.urlencode({
        "filters": json.dumps([{"field": "reservation._id", "operator": "$eq", "value": reservation_id}]),
        "limit": 1,
    })
    code, data = http("GET", f"{OPEN_API}/communication/conversations?{qs}", token=token)
    if code != 200 or not isinstance(data, dict):
        return None
    convs = data.get("data", {}).get("conversations", [])
    return convs[0]["_id"] if convs else None


def list_recent_notes(token, conversation_id, limit=10):
    """Return last N posts on this conversation. Used to detect a prior
    publish-attempt note."""
    code, data = http(
        "GET",
        f"{OPEN_API}/communication/conversations/{conversation_id}/posts?limit={limit}&sort=-createdAt",
        token=token,
    )
    if code != 200 or not isinstance(data, dict):
        return []
    return data.get("data", {}).get("posts") or data.get("data") or []


def post_note(token, conversation_id, body):
    return http(
        "POST",
        f"{OPEN_API}/communication/conversations/{conversation_id}/send-message",
        token=token,
        body={"body": body, "module": {"type": "note"}},
    )


def list_upcoming_confirmed(token):
    page = 100
    skip = 0
    out = []
    now_ms = time.time() * 1000
    while True:
        qs = urllib.parse.urlencode({
            "limit": page,
            "skip": skip,
            "fields": "_id confirmationCode status checkIn checkOut",
            "filters": json.dumps([{"field": "status", "operator": "$eq", "value": "confirmed"}]),
            "sort": "-checkOut",
        })
        code, data = http("GET", f"{OPEN_API}/reservations?{qs}", token=token)
        if code != 200 or not isinstance(data, dict):
            print(f"list failed: {code} {data}", file=sys.stderr)
            break
        results = data.get("results", [])
        out.extend(results)
        if len(results) < page:
            break
        skip += page
        if skip >= 1000:
            break
    # only upcoming/in-stay
    def parse_ms(s):
        try:
            return time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        except Exception:
            return 0
    return [r for r in out if parse_ms(r.get("checkOut", "")) > now_ms]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--slug", default=os.environ.get("GUESTY_ACCOUNT_SLUG", "fidum_company"))
    args = ap.parse_args()

    dyn = base64.b64encode(f"{{{{guest_app::{args.slug}}}}}".encode()).decode()
    tag = f"{{{{guest_app::{args.slug}}}}}"

    token = get_token()
    print(f"slug={args.slug} dry={args.dry}")

    upcoming = list_upcoming_confirmed(token)
    print(f"{len(upcoming)} upcoming confirmed reservations")

    candidates = []
    for r in upcoming:
        rid = r["_id"]
        cc = r.get("confirmationCode", "")
        ci = r.get("checkIn", "")[:10]
        rt = runtime_status(rid, dyn)
        if rt == 404:
            candidates.append(r)
        marker = " [404]" if rt == 404 else (f" [{rt}]" if rt != 200 else "")
        print(f"  {cc:18s} ci={ci}{marker}")

    print(f"\n{len(candidates)} reservations need publishing")
    if args.dry:
        return
    if not candidates:
        return

    # Phase 1: post notes
    posted = []  # (cc, rid)
    n_post_fail = n_no_conv = 0
    for i, r in enumerate(candidates):
        if args.limit and i >= args.limit:
            print(f"hit limit={args.limit}")
            break
        rid = r["_id"]
        cc = r.get("confirmationCode", "")
        conv = find_conversation(token, rid)
        if not conv:
            print(f"  POST {cc}: NO CONVERSATION; skip")
            n_no_conv += 1
            continue
        code, data = post_note(token, conv, tag)
        if code not in (200, 201):
            print(f"  POST {cc}: failed {code} {str(data)[:160]}")
            n_post_fail += 1
            continue
        posted.append((cc, rid))
        print(f"  POST {cc}: ok")

    if not posted:
        print(f"\nDONE no posts succeeded (no_conv={n_no_conv} fail={n_post_fail})")
        return

    # Phase 2: wait, then verify
    print(f"\nWaiting 30s for Guesty to publish runtimes...")
    time.sleep(30)

    n_ok = n_still_404 = 0
    for cc, rid in posted:
        rt = runtime_status(rid, dyn)
        if rt == 200:
            n_ok += 1
            print(f"  VERIFY {cc}: 200 OK")
        else:
            # one more retry after another 15s
            time.sleep(0)  # no extra delay on first; only sleep if needed
            n_still_404 += 1
            print(f"  VERIFY {cc}: still {rt}")

    if n_still_404:
        print(f"\nRetrying {n_still_404} stragglers after another 15s...")
        time.sleep(15)
        retry_fail = 0
        for cc, rid in posted:
            rt = runtime_status(rid, dyn)
            if rt != 200:
                retry_fail += 1
                print(f"  RETRY {cc}: still {rt}")
        n_ok = len(posted) - retry_fail
        n_still_404 = retry_fail

    print(f"\nDONE published={n_ok} still_404={n_still_404} no_conv={n_no_conv} post_fail={n_post_fail}")


if __name__ == "__main__":
    main()
