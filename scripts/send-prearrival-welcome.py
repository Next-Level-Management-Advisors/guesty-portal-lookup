#!/usr/bin/env python3
"""One-shot backfill: send the "Pre-arrival welcome" saved reply to every
confirmed upcoming reservation on a real outbound channel.

Implementation: POSTs the raw saved-reply body (with `{{...}}` merge tags
intact) to /communication/conversations/<id>/send-message. Guesty renders
the merge tags server-side at delivery time — same way it renders
`{{guest_app::<slug>}}` in our portal-publish flow. There is no public
render-only endpoint, so we send and let Guesty render in flight.

Channel filter: only sends on real outbound modules (airbnb2, bookingCom,
Booking.com, email, sms, whatsapp). Synthetic modules (log, Uploaded_*,
aiSummary, direct, note) are skipped — those don't deliver to the guest.

Default mode is DRY-RUN. Pass --apply to actually send.
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
SAVED_REPLY_ID = "69fbc1e6081bbfc8283a1335"  # Pre-arrival welcome
SLUG = os.environ.get("GUESTY_ACCOUNT_SLUG", "fidum_company")


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
        return e.code, e.read().decode(errors="replace")[:400]


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


def list_upcoming_confirmed(token):
    page = 100
    skip = 0
    out = []
    now_ms = time.time() * 1000
    while True:
        qs = urllib.parse.urlencode({
            "limit": page,
            "skip": skip,
            "fields": "_id confirmationCode status checkIn checkOut guest source",
            "filters": json.dumps([{"field": "status", "operator": "$eq", "value": "confirmed"}]),
            "sort": "checkIn",
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

    def parse_ms(s):
        try:
            return time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        except Exception:
            return 0

    # future check-ins only
    return [r for r in out if parse_ms(r.get("checkIn", "")) > now_ms]


def find_conversation(token, reservation_id):
    qs = urllib.parse.urlencode({
        "filters": json.dumps([{"field": "reservation._id", "operator": "$eq", "value": reservation_id}]),
        "limit": 1,
    })
    code, data = http("GET", f"{OPEN_API}/communication/conversations?{qs}", token=token)
    if code != 200 or not isinstance(data, dict):
        return None, None
    convs = data.get("data", {}).get("conversations") or []
    if not convs:
        return None, None
    conv = convs[0]
    return conv["_id"], conv


def detect_module(token, conversation_id):
    """Find the most-recent guest-visible (non-note, non-system) channel
    module on the conversation. Falls back to None."""
    qs = urllib.parse.urlencode({"limit": 25, "sort": "-createdAt"})
    code, data = http("GET", f"{OPEN_API}/communication/conversations/{conversation_id}/posts?{qs}", token=token)
    if code != 200 or not isinstance(data, dict):
        return None
    posts = data.get("data", {}).get("posts") or data.get("data") or []
    if not isinstance(posts, list):
        return None
    for p in posts:
        mod = p.get("module")
        if isinstance(mod, dict):
            t = mod.get("type")
        else:
            t = mod
        if t and t not in ("note", "system"):
            return t
    return None


def get_saved_reply_body(token, saved_reply_id):
    """Fetch the raw saved-reply body (with merge tags intact)."""
    code, data = http("GET", f"{OPEN_API}/saved-replies/{saved_reply_id}", token=token)
    if code != 200 or not isinstance(data, dict):
        return None
    payload = data.get("data") if isinstance(data.get("data"), dict) else data
    return payload.get("answer") or payload.get("body")


# Real outbound channels — these actually deliver to the guest.
# Display names from posts (left) get normalized to Guesty's send-message
# enum values (right). Anything not in this map is skipped.
CHANNEL_NORMALIZE = {
    "airbnb2": "airbnb2",
    "airbnb": "airbnb2",
    "bookingCom": "bookingCom",
    "Booking.com": "bookingCom",
    "booking.com": "bookingCom",
    "email": "email",
    "sms": "sms",
    "whatsapp": "whatsapp",
}
REAL_CHANNELS = set(CHANNEL_NORMALIZE.keys())


def send_message(token, conversation_id, body, module_type):
    return http(
        "POST",
        f"{OPEN_API}/communication/conversations/{conversation_id}/send-message",
        token=token,
        body={"body": body, "module": {"type": module_type}},
    )


# A distinctive substring that appears in the rendered "Pre-arrival welcome"
# body. Used to skip reservations that have already received it.
ALREADY_SENT_NEEDLE = "Thanks for booking with us! Your stay at"


def already_received_welcome(token, conversation_id):
    """Return True if the conversation already has a host post containing
    our welcome-message hook string."""
    code, data = http(
        "GET",
        f"{OPEN_API}/communication/conversations/{conversation_id}/posts?limit=25&sort=-createdAt",
        token=token,
    )
    if code != 200 or not isinstance(data, dict):
        return False
    posts = data.get("data", {}).get("posts") or data.get("data") or []
    if not isinstance(posts, list):
        return False
    for p in posts:
        body = p.get("body") or ""
        if ALREADY_SENT_NEEDLE in body:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually send (default is dry-run)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--saved-reply", default=SAVED_REPLY_ID)
    args = ap.parse_args()

    mode = "APPLY" if args.apply else "DRY-RUN"
    token = get_token()
    print(f"mode={mode} saved_reply={args.saved_reply} slug={SLUG}\n")

    reservations = list_upcoming_confirmed(token)
    print(f"{len(reservations)} confirmed reservations with future check-in\n")

    body = get_saved_reply_body(token, args.saved_reply)
    if not body:
        raise SystemExit(f"Could not fetch saved-reply {args.saved_reply}")
    print(f"--- saved-reply body (with merge tags) ---\n{body}\n--- end ---\n")

    plan = []  # in-channel
    skipped_no_channel = []  # detected module not in REAL_CHANNELS
    skipped_no_conv = []
    for r in reservations:
        rid = r["_id"]
        cc = r.get("confirmationCode", "")
        ci = r.get("checkIn", "")[:10]
        guest = (r.get("guest") or {}).get("fullName") or "?"
        source = r.get("source", "")

        conv_id, conv = find_conversation(token, rid)
        if not conv_id:
            skipped_no_conv.append((cc, ci, source, guest))
            continue

        raw_module = detect_module(token, conv_id) or source
        module = CHANNEL_NORMALIZE.get(raw_module)
        rec = {"cc": cc, "rid": rid, "conv_id": conv_id, "module": module,
               "raw_module": raw_module, "guest": guest, "ci": ci, "source": source}
        if module:
            plan.append(rec)
        else:
            skipped_no_channel.append(rec)

    print(f"=== plan ===")
    print(f"  to-send (real channel): {len(plan)}")
    print(f"  skip (no conversation): {len(skipped_no_conv)}")
    print(f"  skip (synthetic module): {len(skipped_no_channel)}")

    by_mod = {}
    for p in plan:
        by_mod[p["module"]] = by_mod.get(p["module"], 0) + 1
    print(f"\nchannels in to-send:")
    for m, n in sorted(by_mod.items(), key=lambda kv: -kv[1]):
        print(f"  {m:14s} {n}")

    print(f"\nfirst 10 to-send:")
    for p in plan[:10]:
        print(f"  {p['cc']:18s} ci={p['ci']} mod={p['module']:12s} guest={p['guest']}")

    print(f"\nskipped (synthetic module):")
    for p in skipped_no_channel[:20]:
        m = p.get("raw_module") or "?"
        print(f"  {p['cc']:18s} ci={p['ci']} mod={m:12s} guest={p['guest']}")

    if not args.apply:
        print(f"\nDRY-RUN complete. Re-run with --apply to send.")
        return

    # APPLY
    n_ok = n_fail = n_skipped = 0
    processed = 0
    for p in plan:
        if args.limit and processed >= args.limit:
            break
        processed += 1
        if already_received_welcome(token, p["conv_id"]):
            n_skipped += 1
            print(f"  SKIP {p['cc']}: already received welcome")
            continue
        code, data = send_message(token, p["conv_id"], body, p["module"])
        if code in (200, 201):
            n_ok += 1
            print(f"  SENT {p['cc']} ({p['module']})")
        else:
            n_fail += 1
            print(f"  FAIL {p['cc']} {code} {str(data)[:160]}")
    print(f"\nDONE sent={n_ok} skipped={n_skipped} failed={n_fail}")


if __name__ == "__main__":
    main()
