#!/usr/bin/env python3
"""Daily morning-briefing trigger for Agent Garrison.

Subcommands:
  fire                       POST the synthetic prompt to gateway /jobs.
  --cron HH:MM <weekdays>    Print the cron expression for the given config.
  --render-prompt [DATE]     Print the rendered briefing prompt (for tests).
                             DATE defaults to today; format YYYY-MM-DD.

The fire subcommand is what the scheduler invokes (via briefing.sh).
The --cron subcommand is shared with setup.sh to avoid duplicating the
time→cron logic. The --render-prompt subcommand exposes the prompt
template to the test suite.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Optional


POST_ATTEMPTS = 3
POST_RETRY_BASE_SECONDS = 0.25


# The proven prompt from the scheduler/SKILL.md cookbook entry, plus
# date/day-of-week substitution per T7 brief §6. Preserves the prior
# semantics around empty report_channel ("log to stdout and stop") and
# both-empty inputs ("post a one-line acknowledgement instead of staying
# silent — briefings have a fixed cadence and the principal expects
# proof-of-life").
# Where the composed briefing goes. Split out of PROMPT_TEMPLATE because the
# destination is the ONE part of the instruction that varies per composition:
# everything else (sources, format, length, tone) is the same briefing whoever
# reads it. The slack clause is verbatim what the template always said, and it
# stays the default, so a composition that sets nothing keeps its old behaviour.
DESTINATION_CLAUSES = {
    "slack": (
        "Post via mcp__claude_ai_Slack__slack_send_message to the "
        "orchestrator report_channel - if report_channel is empty, log to "
        "stdout and stop, do not search Slack. "
    ),
    "whatsapp": (
        "Deliver it over WhatsApp. From the composition dir run: node "
        "apm_modules/_local/whatsapp-web/scripts/connector.mjs call send_text "
        "with a JSON arg whose to field is exactly {whatsapp_jid} and whose "
        "body field is the briefing text. Use that JID verbatim - do NOT call "
        "resolve_contact, do not guess, and do not substitute another "
        "recipient. The call returns queued:true with an executeAt: the "
        "message is parked for a 60-second cancel window and then goes out on "
        "its own. That is the expected result - do not call send_text a second "
        "time and do not report it as a failure. "
    ),
    "stdout": (
        "Do not send this anywhere. Print the composed briefing to stdout and "
        "stop - this is a dry run. "
    ),
}


PROMPT_TEMPLATE = (
    "Morning briefing trigger. Today is {date} ({day_of_week}).\n\n"
    "{workdir}"
    "Compose my morning briefing from the data below. "
    "{sources}"
    "{destination}"
    "Format: events in chronological order, two task suggestions with "
    "one-sentence reasons, anything blocking (only if you genuinely "
    "identify a blocker; skip the section otherwise — don't fabricate). "
    "If both inputs are empty, post a one-line acknowledgement instead "
    "of staying silent — briefings have a fixed cadence and the "
    "principal expects proof-of-life. "
    "Keep it under 200 words. No filler ('Good morning!', 'Have a great "
    "day!'). The principal sees this every weekday; preserve their "
    "attention. "
    "This is informational — don't offer to do work autonomously here. "
    "If the principal wants to act they'll reply on whichever channel "
    "this arrived on, and the "
    "heartbeat approval flow takes it from there."
)



# ── Source gathering ─────────────────────────────────────────────────────────
# The operative gets DATA, not fetch instructions. See the module docstring for
# why it cannot fetch: connector credentials reach only the Automations engine.

CONNECTOR_TIMEOUT_S = 60


def garrison_home() -> str:
    return os.environ.get("GARRISON_HOME") or os.path.join(
        os.path.expanduser("~"), ".garrison"
    )


def app_url() -> str:
    explicit = os.environ.get("GARRISON_APP_URL")
    if explicit:
        return explicit.rstrip("/")
    # Same derivation as the gateway's: the committed base shifted by the
    # instance profile's offset. Never a literal for one instance.
    offset = int(os.environ.get("GARRISON_PORT_OFFSET", "0") or "0")
    return f"http://127.0.0.1:{8777 + offset}"


def internal_token() -> str:
    """The 0600 capability token that gates the auth-env route.

    Same trust boundary as the vault key file: readable by this user's own
    processes only, and briefing.py is one of Garrison's own.
    """
    path = os.environ.get("GARRISON_INTERNAL_TOKEN_PATH") or os.path.join(
        garrison_home(), "internal-token"
    )
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def connector_auth_env(connector: str) -> Optional[dict]:
    """This connector's freshly-materialised auth env, or None if not connected.

    None means "no usable credential" for every reason (409 awaiting_connector,
    no internal token, app unreachable) — the briefing reports the source as
    unavailable rather than guessing which.
    """
    token = internal_token()
    if not token:
        return None
    req = urllib.request.Request(
        f"{app_url()}/api/connectors/{connector}/auth-env",
        data=b"{}",
        method="POST",
        headers={"Content-Type": "application/json", "x-garrison-internal": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8")).get("env") or {}
    except Exception:
        return None


def connector_call(connector: str, action: str, args: dict):
    """(result, error). error is a short human phrase, never a stack trace."""
    comp = (os.environ.get("GARRISON_COMPOSITION_DIR") or "").strip()
    if not comp:
        return None, "composition dir unknown"
    script = os.path.join(
        comp, "apm_modules", "_local", connector, "scripts", "connector.mjs"
    )
    if not os.path.exists(script):
        return None, "connector not installed in this composition"
    auth = connector_auth_env(connector)
    if auth is None:
        return None, "not connected"
    env = {**os.environ, **auth}
    try:
        proc = subprocess.run(
            ["node", script, "call", action, json.dumps(args)],
            capture_output=True, text=True, env=env, cwd=comp,
            timeout=CONNECTOR_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out"
    try:
        payload = json.loads((proc.stdout or "").strip() or "{}")
    except json.JSONDecodeError:
        return None, "unreadable connector output"
    if not payload.get("ok"):
        return None, str(payload.get("error") or "call failed")
    return payload.get("result"), None


def _today_events(today: date):
    """Today's calendar events, chronological. calendar.list_events has no
    time_max, so the day window is applied here."""
    result, err = connector_call(
        "google", "calendar.list_events", {"time_min": f"{today.isoformat()}T00:00:00Z"}
    )
    if err:
        return None, err
    # The connector returns the Google shape: {"items": [...]}. Reading a
    # guessed "events" key silently yielded an empty day with ok:true, which
    # reads exactly like a free calendar.
    if isinstance(result, list):
        items = result
    else:
        result = result or {}
        items = result.get("items") or result.get("events") or []
    out = []
    for ev in items:
        start = ev.get("start") or {}
        when = start.get("dateTime") or start.get("date") or ""
        if not when.startswith(today.isoformat()):
            continue
        out.append({"when": when, "summary": ev.get("summary") or "(no title)"})
    out.sort(key=lambda e: e["when"])
    return out, None


def _todo_cards():
    """Open cards in the Trello board's A Fazer list."""
    lists, err = connector_call("trello", "lists", {})
    if err:
        return None, err
    target = None
    for lst in lists or []:
        if str(lst.get("name", "")).strip().lower() == "a fazer":
            target = lst.get("id")
            break
    if not target:
        return None, "no 'A Fazer' list on the board"
    cards, err = connector_call("trello", "list_cards", {"list_id": target})
    if err:
        return None, err
    return [c.get("name") for c in (cards or []) if c.get("name")], None


def gather_sources(today: date) -> dict:
    events, ev_err = _today_events(today)
    tasks, task_err = _todo_cards()
    return {
        "events": events, "events_error": ev_err,
        "tasks": tasks, "tasks_error": task_err,
    }


def sources_clause(data: dict) -> str:
    """The gathered data as prompt text, and an honest note for what failed."""
    parts = []
    events, tasks = data.get("events"), data.get("tasks")

    if events is None:
        parts.append(
            f"Calendar: UNAVAILABLE ({data['events_error']}). Say so plainly in "
            "one clause; do not invent events and do not try to fetch them "
            "yourself — you have no credentials for connectors. "
        )
    elif not events:
        parts.append("Calendar: no events today. ")
    else:
        listed = "; ".join(f"{e['when']} {e['summary']}" for e in events)
        parts.append(f"Today's calendar events, already in order: {listed}. ")

    if tasks is None:
        parts.append(
            f"Tasks: UNAVAILABLE ({data['tasks_error']}). Same rule — say so, "
            "invent nothing, fetch nothing. "
        )
    elif not tasks:
        parts.append("Tasks: the A Fazer list is empty. ")
    else:
        parts.append("Open A Fazer tasks: " + "; ".join(tasks) + ". ")

    parts.append(
        "These are the ONLY inputs. They are already fetched for you — do not "
        "run any connector, and do not treat a missing source as something to "
        "go and fix. "
    )
    return "".join(parts)

def delivery_config() -> tuple[str, str]:
    """(delivery, whatsapp_jid) from env.

    Two names per knob, same precedence rule setup.sh uses: the explicit
    GARRISON_* runtime override wins, then the composition config the runner
    projects as <FITTING_ID>_<KEY> (setupConfigEnv in src/lib/runner.ts), then
    the schema default. Reading only one of the two names is exactly the bug
    that made briefing_time silently ignore the composition.
    """
    delivery = (
        os.environ.get("GARRISON_BRIEFING_DELIVERY")
        or os.environ.get("MORNING_BRIEFING_DELIVERY")
        or "slack"
    ).strip().lower()
    jid = (
        os.environ.get("GARRISON_BRIEFING_WHATSAPP_JID")
        or os.environ.get("MORNING_BRIEFING_WHATSAPP_JID")
        or ""
    ).strip()
    return delivery, jid


def destination_clause(delivery: str, whatsapp_jid: str) -> str:
    """Resolve the delivery clause, or raise if the config cannot deliver.

    A misconfigured destination fails HERE, before the gateway is asked to spend
    a model turn composing a briefing that has nowhere to go. Silently falling
    back to stdout would look like success in the scheduler log and produce
    nothing the principal ever sees - the exact failure this Fitting already had
    with an empty report_channel.
    """
    if delivery not in DESTINATION_CLAUSES:
        raise ValueError(
            f"unknown delivery '{delivery}'; expected one of "
            + ", ".join(sorted(DESTINATION_CLAUSES))
        )
    if delivery == "whatsapp" and not whatsapp_jid:
        raise ValueError(
            "delivery=whatsapp needs whatsapp_jid (an exact JID like "
            "351900000000@s.whatsapp.net); set it in the composition config or "
            "via GARRISON_BRIEFING_WHATSAPP_JID"
        )
    return DESTINATION_CLAUSES[delivery].format(whatsapp_jid=whatsapp_jid)


def workdir_clause() -> str:
    """Tell the session where the connectors actually are.

    The operative runs in its own session dir, not the composition dir, so a
    relative "apm_modules/_local/<x>/scripts/connector.mjs" resolves to nothing
    and every data source AND the delivery call fail with MODULE_NOT_FOUND.
    GARRISON_COMPOSITION_DIR is projected into fitting processes
    (composition-env.ts), and setup.sh bakes it into the job command because the
    scheduler daemon's env does not carry it.
    """
    comp = (os.environ.get("GARRISON_COMPOSITION_DIR") or "").strip()
    if not comp:
        # No worse than before: the prompt keeps saying "from the composition
        # dir" and the session has to find it. Better than inventing a path.
        return ""
    return (
        f"Before anything else, cd to {comp} — that is the composition dir, and "
        "EVERY apm_modules/_local/... path below is relative to it. Your session "
        "does not start there, so a relative path without this cd fails with "
        "MODULE_NOT_FOUND and the briefing silently loses that source. "
    )


def render_prompt(today: Optional[date] = None, sources: Optional[dict] = None) -> str:
    if today is None:
        today = date.today()
    delivery, jid = delivery_config()
    data = sources if sources is not None else gather_sources(today)
    return PROMPT_TEMPLATE.format(
        date=today.isoformat(),
        day_of_week=today.strftime("%A"),
        workdir=workdir_clause(),
        sources=sources_clause(data),
        destination=destination_clause(delivery, jid),
    )


def gateway_url() -> str:
    explicit = os.environ.get("GARRISON_GATEWAY_URL")
    if explicit:
        return explicit.rstrip("/")
    host = os.environ.get("GARRISON_GATEWAY_HOST", "127.0.0.1")
    port = os.environ.get("GARRISON_GATEWAY_PORT")
    if not port:
        # HARD RULE: never a port literal for one instance. The gateway is the
        # base-family 4777 shifted by the instance profile's offset (prod
        # +1000, codex +20000), exactly like scripts/garrison-instance.sh.
        offset = int(os.environ.get("GARRISON_PORT_OFFSET", "0") or "0")
        port = str(4777 + offset)
    return f"http://{host}:{port}"


def cmd_fire() -> int:
    today = date.today()
    delivery, _jid = delivery_config()
    sources = gather_sources(today)
    body = {
        "kind": "morning-briefing",
        "date": today.isoformat(),
        "day_of_week": today.strftime("%A"),
        # Echoed so the gateway log says where a given fire was meant to land;
        # without it a briefing that vanished is indistinguishable from one that
        # was delivered somewhere nobody was looking.
        "delivery": delivery,
        "instructions": render_prompt(today, sources),
    }
    url = f"{gateway_url()}/jobs"
    data = json.dumps(body).encode("utf-8")
    for attempt in range(1, POST_ATTEMPTS + 1):
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
                payload = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            status = exc.code
            payload = exc.read().decode("utf-8", "replace")
        except urllib.error.URLError as exc:
            print(
                f"failed to POST to {url} (attempt {attempt}/{POST_ATTEMPTS}): {exc}",
                file=sys.stderr,
            )
            if attempt == POST_ATTEMPTS:
                return 1
            time.sleep(POST_RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
            continue

        if status < 300:
            print(payload)
            return 0
        print(
            f"gateway returned {status} (attempt {attempt}/{POST_ATTEMPTS}): {payload}",
            file=sys.stderr,
        )
        # 5xx (including 503 ingress backpressure) is retryable. A 4xx is a
        # payload/configuration error and should fail immediately.
        if status < 500 or attempt == POST_ATTEMPTS:
            return 1
        time.sleep(POST_RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
    return 1


def compute_cron(time_hhmm: str, weekdays_only: bool) -> str:
    parts = time_hhmm.strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"briefing_time must be HH:MM, got '{time_hhmm}'")
    hour = int(parts[0])
    minute = int(parts[1])
    if not (0 <= hour <= 23):
        raise ValueError(f"hour out of range: {hour}")
    if not (0 <= minute <= 59):
        raise ValueError(f"minute out of range: {minute}")
    dow = "1-5" if weekdays_only else "*"
    return f"{minute} {hour} * * {dow}"


def cmd_cron(time_hhmm: str, weekdays_arg: str) -> int:
    weekdays_only = weekdays_arg.strip().lower() in ("1", "true", "yes", "y")
    print(compute_cron(time_hhmm, weekdays_only))
    return 0


def cmd_render_prompt(date_str: Optional[str]) -> int:
    today = date.fromisoformat(date_str) if date_str else None
    sys.stdout.write(render_prompt(today))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="briefing.py")
    parser.add_argument("--cron", nargs=2, metavar=("HH:MM", "WEEKDAYS"))
    parser.add_argument("--render-prompt", nargs="?", const="", metavar="DATE")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("fire")
    args = parser.parse_args(argv)
    if args.cron:
        return cmd_cron(args.cron[0], args.cron[1])
    if args.render_prompt is not None:
        return cmd_render_prompt(args.render_prompt or None)
    if args.cmd == "fire":
        return cmd_fire()
    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
