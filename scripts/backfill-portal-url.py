#!/usr/bin/env python3
"""Backfill the portal_url custom field on all FIDUM reservations.

Usage:
  python3 backfill-portal-url.py [--limit N] [--dry]

Reads token from one of the cached files written by the portal-lookup app.
"""
import glob, json, os, sys, tempfile, time, urllib.parse, urllib.request, urllib.error

FIELD_ID = "69fd754641a994001af0a67b"
BASE = "https://open-api.guesty.com/v1"
TOKEN_FILES = sorted(
    glob.glob(os.path.join(tempfile.gettempdir(), "guesty-open-api-token-*.json"))
    + glob.glob("/tmp/guesty-open-api-token-*.json")
)


def get_token():
    now_ms = time.time() * 1000
    for f in TOKEN_FILES:
        try:
            d = json.load(open(f))
            if d.get("expires_at", 0) > now_ms + 60000:
                return d["access_token"]
        except FileNotFoundError:
            continue
    raise SystemExit("No valid cached token found; run a portal-lookup request to refresh.")


def http(method, path, token, body=None):
    url = BASE + path if path.startswith("/") else path
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")[:300]
        return e.code, body_text


def list_page(token, skip, limit):
    qs = urllib.parse.urlencode({
        "limit": limit,
        "skip": skip,
        "fields": "_id confirmationCode status checkOut",
        "sort": "-checkOut",
    })
    code, data = http("GET", f"/reservations?{qs}", token)
    if code >= 400:
        raise SystemExit(f"List failed: {code} {data}")
    return data.get("results", [])


def set_url(token, rid, url):
    code, data = http("PUT", f"/reservations-v3/{rid}/custom-fields", token, {
        "customFields": [{"fieldId": FIELD_ID, "value": url}],
    })
    return code, data


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    limit = 0
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])

    token = get_token()
    print(f"token len={len(token)}, dry={dry}, limit={'all' if limit == 0 else limit}")

    page = 100
    skip = 0
    processed = 0
    set_ok = 0
    skipped = 0
    failed = 0

    while True:
        results = list_page(token, skip, page)
        if not results:
            break
        print(f"page skip={skip} count={len(results)}")

        for r in results:
            rid = r.get("_id")
            code_val = r.get("confirmationCode") or ""
            processed += 1

            if not code_val:
                skipped += 1
                continue

            url = f"https://portal.fidumcompany.com/?code={urllib.parse.quote(code_val)}"

            if dry:
                if processed <= 5 or processed % 50 == 0:
                    print(f"DRY {processed:4d} {rid} {code_val} -> {url}")
            else:
                http_code, resp = set_url(token, rid, url)
                if http_code in (200, 204):
                    set_ok += 1
                    if set_ok <= 3 or set_ok % 25 == 0:
                        print(f"OK  {processed:4d} {rid} {code_val}")
                else:
                    failed += 1
                    print(f"FAIL {rid} {http_code} {resp}")

            if limit and processed >= limit:
                break

        if limit and processed >= limit:
            print(f"hit limit={limit}")
            break
        if len(results) < page:
            break
        skip += page

    print(f"DONE processed={processed} set={set_ok} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    main()
