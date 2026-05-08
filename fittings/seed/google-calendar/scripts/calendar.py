#!/usr/bin/env python3
"""Google Calendar CLI for Agent Garrison.

Subcommands:
  --setup                  Refresh existing token or run OAuth loopback flow.
  --probe                  Refresh token + read-only smoke call. Prints "ok".
  --render-fixture <path>  Render a JSON event-fixture to markdown (for tests).
  list <range>             today | tomorrow | this-week | YYYY-MM-DD..YYYY-MM-DD
  create --title T --start ISO --end ISO [--location L] [--description D]
  update <id> [--title T] [--start ISO] [--end ISO] [--location L] [--description D]
  delete <id>
  sync                     Pull today + tomorrow + next 5 days, write calendar.md.

Token store: ~/.garrison/google-calendar/token.json (mode 0600).
Calendar markdown path: $GARRISON_CALENDAR_FILE or data/calendar.md (cwd-relative).
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import stat
import sys
import urllib.parse
import webbrowser
from datetime import date, datetime, time, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Iterable, Optional

SCOPES = ["https://www.googleapis.com/auth/calendar"]
TOKEN_DIR = Path.home() / ".garrison" / "google-calendar"
TOKEN_PATH = TOKEN_DIR / "token.json"
OAUTH_TIMEOUT_S = 120


def _err(msg: str) -> None:
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# Token I/O
# ---------------------------------------------------------------------------


def _load_token() -> Optional[dict]:
    if not TOKEN_PATH.exists():
        return None
    try:
        return json.loads(TOKEN_PATH.read_text())
    except json.JSONDecodeError:
        return None


def _save_token(data: dict) -> None:
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TOKEN_DIR, 0o700)
    TOKEN_PATH.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(TOKEN_PATH, 0o600)


def _client_creds() -> tuple[str, str]:
    cid = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    csecret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    if not cid or not csecret:
        raise RuntimeError(
            "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set "
            "(resolve via vault)"
        )
    return cid, csecret


def _credentials():
    """Return live google.oauth2.credentials.Credentials or raise."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    raw = _load_token()
    if not raw:
        raise RuntimeError("no token.json — run setup first")

    cid, csecret = _client_creds()
    creds = Credentials(
        token=raw.get("access_token"),
        refresh_token=raw.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=raw.get("client_id") or cid,
        client_secret=raw.get("client_secret") or csecret,
        scopes=SCOPES,
    )
    if not creds.valid:
        if not creds.refresh_token:
            raise RuntimeError("token has no refresh_token; re-run setup")
        creds.refresh(Request())
        _save_token(_serialize_creds(creds))
    return creds


def _serialize_creds(creds) -> dict:
    return {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "expiry": creds.expiry.isoformat() if creds.expiry else None,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or SCOPES),
    }


def _service():
    from googleapiclient.discovery import build

    return build("calendar", "v3", credentials=_credentials(), cache_discovery=False)


# ---------------------------------------------------------------------------
# OAuth loopback flow
# ---------------------------------------------------------------------------


class _OAuthHandler(BaseHTTPRequestHandler):
    server_version = "GarrisonOAuthLoopback/0.1"
    code_holder: dict = {}

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        if "error" in params:
            self.code_holder["error"] = params["error"][0]
            body = "Authorization failed. You can close this tab.".encode()
        elif "code" in params:
            self.code_holder["code"] = params["code"][0]
            body = (
                "Garrison Google Calendar authorized. You can close this tab."
            ).encode()
        else:
            self.code_holder["error"] = "missing code"
            body = "Missing authorization code.".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        return


def _do_oauth_flow() -> None:
    from google_auth_oauthlib.flow import Flow

    cid, csecret = _client_creds()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    redirect_uri = f"http://127.0.0.1:{port}/callback"
    client_config = {
        "installed": {
            "client_id": cid,
            "client_secret": csecret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        }
    }

    flow = Flow.from_client_config(client_config, scopes=SCOPES)
    flow.redirect_uri = redirect_uri
    auth_url, _ = flow.authorization_url(
        access_type="offline", prompt="consent", include_granted_scopes="true"
    )

    print("Open this URL in your browser to authorize Garrison's Calendar access:")
    print(auth_url)
    try:
        webbrowser.open(auth_url, new=1, autoraise=True)
    except Exception:
        pass

    httpd = HTTPServer(("127.0.0.1", port), _OAuthHandler)
    httpd.timeout = OAUTH_TIMEOUT_S
    _OAuthHandler.code_holder = {}
    httpd.handle_request()

    if "error" in _OAuthHandler.code_holder:
        raise RuntimeError(f"OAuth flow failed: {_OAuthHandler.code_holder['error']}")
    code = _OAuthHandler.code_holder.get("code")
    if not code:
        raise RuntimeError("OAuth flow timed out or returned no code")

    flow.fetch_token(code=code)
    _save_token(_serialize_creds(flow.credentials))


def cmd_setup() -> int:
    raw = _load_token()
    if raw:
        try:
            _credentials()  # triggers refresh if needed
            print("ok")
            return 0
        except Exception as exc:
            _err(f"existing token unusable ({exc}); restarting OAuth flow")
    _do_oauth_flow()
    print("ok")
    return 0


def cmd_probe() -> int:
    try:
        svc = _service()
        svc.events().list(calendarId="primary", maxResults=1).execute()
    except Exception as exc:
        _err(f"probe failed: {exc}")
        return 1
    print("ok")
    return 0


# ---------------------------------------------------------------------------
# Calendar event ops
# ---------------------------------------------------------------------------


def _parse_range(spec: str) -> tuple[datetime, datetime]:
    today = date.today()
    if spec == "today":
        start = datetime.combine(today, time.min)
        end = datetime.combine(today + timedelta(days=1), time.min)
    elif spec == "tomorrow":
        d = today + timedelta(days=1)
        start = datetime.combine(d, time.min)
        end = datetime.combine(d + timedelta(days=1), time.min)
    elif spec == "this-week":
        start = datetime.combine(today, time.min)
        end = datetime.combine(today + timedelta(days=7), time.min)
    elif ".." in spec:
        a, b = spec.split("..", 1)
        start = datetime.combine(date.fromisoformat(a), time.min)
        end = datetime.combine(date.fromisoformat(b) + timedelta(days=1), time.min)
    else:
        raise ValueError(f"unrecognized range: {spec}")
    tz = _local_tz()
    return start.replace(tzinfo=tz), end.replace(tzinfo=tz)


def _summarize_event(ev: dict) -> dict:
    start = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
    end = ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date")
    out = {
        "id": ev.get("id"),
        "summary": ev.get("summary", ""),
        "start": start,
        "end": end,
    }
    if ev.get("location"):
        out["location"] = ev["location"]
    if ev.get("description"):
        out["description"] = ev["description"]
    return out


def cmd_list(args: argparse.Namespace) -> int:
    start, end = _parse_range(args.range)
    svc = _service()
    page = svc.events().list(
        calendarId="primary",
        timeMin=start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        timeMax=end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        singleEvents=True,
        orderBy="startTime",
        maxResults=250,
    ).execute()
    items = [_summarize_event(ev) for ev in page.get("items", [])]
    print(json.dumps(items, indent=2))
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    body = {
        "summary": args.title,
        "start": {"dateTime": args.start},
        "end": {"dateTime": args.end},
    }
    if args.location:
        body["location"] = args.location
    if args.description:
        body["description"] = args.description
    svc = _service()
    created = svc.events().insert(calendarId="primary", body=body).execute()
    print(json.dumps({"id": created.get("id"), "htmlLink": created.get("htmlLink")}))
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    body: dict = {}
    if args.title is not None:
        body["summary"] = args.title
    if args.start is not None:
        body["start"] = {"dateTime": args.start}
    if args.end is not None:
        body["end"] = {"dateTime": args.end}
    if args.location is not None:
        body["location"] = args.location
    if args.description is not None:
        body["description"] = args.description
    if not body:
        _err("update needs at least one field flag")
        return 1
    svc = _service()
    updated = svc.events().patch(calendarId="primary", eventId=args.id, body=body).execute()
    print(json.dumps({"id": updated.get("id"), "htmlLink": updated.get("htmlLink")}))
    return 0


def cmd_delete(args: argparse.Namespace) -> int:
    svc = _service()
    svc.events().delete(calendarId="primary", eventId=args.id).execute()
    print(json.dumps({"id": args.id, "deleted": True}))
    return 0


# ---------------------------------------------------------------------------
# Sync to calendar.md
# ---------------------------------------------------------------------------


def _local_tz():
    try:
        from zoneinfo import ZoneInfo
        from tzlocal import get_localzone_name

        return ZoneInfo(get_localzone_name())
    except Exception:
        return timezone.utc


def _calendar_file_path() -> Path:
    override = os.environ.get("GARRISON_CALENDAR_FILE")
    if override:
        return Path(override)
    return Path.cwd() / "data" / "calendar.md"


def _is_all_day(ev_summary: dict) -> bool:
    s = ev_summary.get("start", "")
    return bool(s) and "T" not in s


def _event_local_dates(ev_summary: dict, tz) -> tuple[date, date, Optional[time], Optional[time]]:
    """Return (start_date, end_date, start_time_or_None, end_time_or_None) in tz."""
    s_raw = ev_summary.get("start") or ""
    e_raw = ev_summary.get("end") or s_raw
    if _is_all_day(ev_summary):
        s_d = date.fromisoformat(s_raw)
        e_d = date.fromisoformat(e_raw) - timedelta(days=1)
        if e_d < s_d:
            e_d = s_d
        return s_d, e_d, None, None
    s_dt = datetime.fromisoformat(s_raw.replace("Z", "+00:00")).astimezone(tz)
    e_dt = datetime.fromisoformat(e_raw.replace("Z", "+00:00")).astimezone(tz)
    return s_dt.date(), e_dt.date(), s_dt.time(), e_dt.time()


def _format_event_for_day(ev_summary: dict, day: date, tz) -> str:
    s_d, e_d, s_t, e_t = _event_local_dates(ev_summary, tz)
    title = ev_summary.get("summary", "(no title)")
    loc = ev_summary.get("location")
    suffix = f" ({loc})" if loc else ""
    if s_t is None:
        return f"- (all day) — {title}{suffix}"
    show_start = s_t if day == s_d else time(0, 0)
    show_end = e_t if day == e_d else time(23, 59)
    return (
        f"- {show_start.strftime('%H:%M')}–{show_end.strftime('%H:%M')} "
        f"— {title}{suffix}"
    )


def _events_overlapping_day(events: Iterable[dict], day: date, tz) -> list[dict]:
    out = []
    for ev in events:
        s_d, e_d, _, _ = _event_local_dates(ev, tz)
        if s_d <= day <= e_d:
            out.append(ev)
    return out


def render_calendar_markdown(
    events: list[dict], now_utc: Optional[datetime] = None, tz=None
) -> str:
    """Pure render function — used by `sync` and by tests."""
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    if tz is None:
        tz = _local_tz()
    today_local = now_utc.astimezone(tz).date()
    tomorrow = today_local + timedelta(days=1)
    next_5 = [today_local + timedelta(days=2 + i) for i in range(5)]

    def _section(label: str, day: date) -> list[str]:
        rows = [
            _format_event_for_day(ev, day, tz)
            for ev in _events_overlapping_day(events, day, tz)
        ]
        rows.sort()
        header = f"## {label} ({day.strftime('%A, %Y-%m-%d')})"
        if not rows:
            return [header, "", "(no events)", ""]
        return [header, "", *rows, ""]

    lines: list[str] = [
        f"# Calendar — synced {now_utc.strftime('%Y-%m-%d %H:%M')} UTC",
        "",
    ]
    lines += _section("Today", today_local)
    lines += _section("Tomorrow", tomorrow)

    next_5_rows: list[str] = []
    for d in next_5:
        day_evs = _events_overlapping_day(events, d, tz)
        if not day_evs:
            continue
        next_5_rows.append(f"### {d.strftime('%A, %Y-%m-%d')}")
        next_5_rows.append("")
        rows = [_format_event_for_day(ev, d, tz) for ev in day_evs]
        rows.sort()
        next_5_rows.extend(rows)
        next_5_rows.append("")
    lines.append("## Next 5 days")
    lines.append("")
    if next_5_rows:
        lines.extend(next_5_rows)
    else:
        lines.append("(empty)")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def cmd_sync() -> int:
    tz = _local_tz()
    now_utc = datetime.now(timezone.utc)
    today_local = now_utc.astimezone(tz).date()
    start = datetime.combine(today_local, time.min, tzinfo=tz)
    end = datetime.combine(today_local + timedelta(days=8), time.min, tzinfo=tz)
    svc = _service()
    page = svc.events().list(
        calendarId="primary",
        timeMin=start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        timeMax=end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        singleEvents=True,
        orderBy="startTime",
        maxResults=500,
    ).execute()
    summaries = [_summarize_event(ev) for ev in page.get("items", [])]
    md = render_calendar_markdown(summaries, now_utc=now_utc, tz=tz)
    target = _calendar_file_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(md)
    print(json.dumps({"path": str(target), "events": len(summaries)}))
    return 0


def cmd_render_fixture(path: str) -> int:
    """Render a JSON fixture to stdout. Used by render tests.

    Fixture shape:
      {
        "events": [...summarized event dicts...],
        "now_utc": "2026-05-08T09:00:00+00:00",   # optional
        "tz": "Europe/Lisbon"                       # optional
      }
    """
    data = json.loads(Path(path).read_text())
    events = data.get("events", [])
    now_utc = (
        datetime.fromisoformat(data["now_utc"].replace("Z", "+00:00"))
        if "now_utc" in data
        else None
    )
    tz = None
    if "tz" in data:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(data["tz"])
    sys.stdout.write(render_calendar_markdown(events, now_utc=now_utc, tz=tz))
    return 0


# ---------------------------------------------------------------------------
# CLI dispatcher
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="calendar.py", add_help=True)
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--render-fixture", dest="render_fixture", metavar="PATH")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list")
    p_list.add_argument("range")

    p_create = sub.add_parser("create")
    p_create.add_argument("--title", required=True)
    p_create.add_argument("--start", required=True)
    p_create.add_argument("--end", required=True)
    p_create.add_argument("--location")
    p_create.add_argument("--description")

    p_update = sub.add_parser("update")
    p_update.add_argument("id")
    p_update.add_argument("--title")
    p_update.add_argument("--start")
    p_update.add_argument("--end")
    p_update.add_argument("--location")
    p_update.add_argument("--description")

    p_delete = sub.add_parser("delete")
    p_delete.add_argument("id")

    sub.add_parser("sync")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.setup:
        return cmd_setup()
    if args.probe:
        return cmd_probe()
    if args.render_fixture:
        return cmd_render_fixture(args.render_fixture)
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "create":
        return cmd_create(args)
    if args.cmd == "update":
        return cmd_update(args)
    if args.cmd == "delete":
        return cmd_delete(args)
    if args.cmd == "sync":
        return cmd_sync()
    build_parser().print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        _err(str(exc))
        sys.exit(1)
