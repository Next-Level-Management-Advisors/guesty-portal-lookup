#!/usr/bin/env python3
"""One-shot backfill: send a short SMS containing the portal link to every
confirmed upcoming reservation that has a phone on file.

Implementation: POSTs the raw body (with merge tags intact) to
/communication/conversations/<id>/send-message with module.type=sms.
Guesty renders {{guest_first}}, {{listing}}, {{portal_url}} server-side.

Idempotency: tracks sent conversationIds in a local JSON state file so
re-runs skip what already sent. DO NOT trust API roundtrip — Guesty's
/posts indexing lags multiple minutes behind /send-message.

Default mode is DRY-RUN. Pass --apply to actually send.
"""
import argparse
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
STATE_FILE = "/tmp/sms-portal-link-sent.json"

BODY = (
    "Hi {{guest_first}}, this is Fidum Company confirming your stay at "
    "{{listing}}. Your guest portal has door code, Wi-Fi, and add-ons: "
    "{{portal_url}}"
)


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
    out = []
    skip = 0
    now_ms = time.time() * 1000
    while True:
        qs = urllib.parse.urlencode({
            "limit": 100, "skip": skip,
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
        if len(results) < 100:
            break
        skip += 100
        if skip >= 1000:
            break

    def parse_ms(s):
        try:
            return time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
        except Exception:
            return 0
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
    # phone may be in conv.guest.phone or conv.meta.guest.phone
    guest = conv.get("guest") or (conv.get("meta") or {}).get("guest") or {}
    phone = guest.get("phone") or (guest.get("phones") or [None])[0]
    return conv["_id"], phone


def send_sms(token, conversation_id):
    return http(
        "POST",
        f"{OPEN_API}/communication/conversations/{conversation_id}/send-message",
        token=token,
        body={"body": BODY, "module": {"type": "sms"}},
    )


def load_state():
    try:
        return set(json.load(open(STATE_FILE)).get("sent_conv_ids", []))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_state(sent: set):
    try:
        json.dump({"sent_conv_ids": sorted(sent), "ts": int(time.time())},
                  open(STATE_FILE, "w"))
    except Exception as e:
        print(f"  WARN: state save failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    mode = "APPLY" if args.apply else "DRY-RUN"
    token = get_token()
    sent = load_state()
    print(f"mode={mode} state_file={STATE_FILE} already_sent={len(sent)}\n")
    print(f"--- SMS body (with merge tags) ---\n{BODY}\n--- end ---\n")

    reservations = list_upcoming_confirmed(token)
    print(f"{len(reservations)} confirmed reservations with future check-in\n")

    plan = []
    no_conv = 0
    no_phone = 0
    for r in reservations:
        rid = r["_id"]
        cc = r.get("confirmationCode", "")
        ci = r.get("checkIn", "")[:10]
        guest = (r.get("guest") or {}).get("fullName") or "?"
        conv_id, phone = find_conversation(token, rid)
        if not conv_id:
            no_conv += 1
            continue
        # Don't gate on phone — Guesty may have it in places we don't see in the
        # conversation summary. Let send-message itself error out if there's
        # no number on file, and treat that as a per-guest skip.
        plan.append({
            "cc": cc, "rid": rid, "conv_id": conv_id,
            "phone": phone, "guest": guest, "ci": ci,
        })

    print(f"=== plan ===")
    print(f"  reservations to attempt: {len(plan)}")
    print(f"  skip (no conversation):  {no_conv}")
    print(f"  with phone visible:      {sum(1 for p in plan if p['phone'])}")
    print(f"  no phone in conv summary: {sum(1 for p in plan if not p['phone'])}\n")

    print("first 10 to-send:")
    for p in plan[:10]:
        ph = p["phone"] or "(unknown)"
        print(f"  {p['cc']:18s} ci={p['ci']} guest={p['guest']:25s} phone={ph}")

    if not args.apply:
        print(f"\nDRY-RUN. Re-run with --apply to send.")
        return

    n_ok = n_skip_state = n_fail_no_phone = n_fail_other = 0
    processed = 0
    for p in plan:
        if args.limit and processed >= args.limit:
            break
        processed += 1
        if p["conv_id"] in sent:
            n_skip_state += 1
            print(f"  SKIP {p['cc']}: already sent (state)")
            continue

        code, data = send_sms(token, p["conv_id"])
        if code in (200, 201):
            n_ok += 1
            sent.add(p["conv_id"])
            save_state(sent)
            print(f"  SENT {p['cc']}")
            continue

        # Common failure: no phone on file
        body_text = str(data)
        if "phone" in body_text.lower() or "recipient" in body_text.lower():
            n_fail_no_phone += 1
            print(f"  NO-PHONE {p['cc']} {code} {body_text[:160]}")
        else:
            n_fail_other += 1
            print(f"  FAIL {p['cc']} {code} {body_text[:160]}")

    print(f"\nDONE sent={n_ok} skip_state={n_skip_state} no_phone={n_fail_no_phone} fail={n_fail_other}")
    print(f"state saved to {STATE_FILE} ({len(sent)} conv ids)")


if __name__ == "__main__":
    main()
