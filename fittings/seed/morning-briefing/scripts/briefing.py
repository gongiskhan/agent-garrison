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
    "Compose my morning briefing. Combine my open Trello tasks "
    "(A Fazer list) with today calendar events. "
    "{destination}"
    "Format: events in chronological order, two task suggestions with "
    "one-sentence reasons, anything blocking (only if you genuinely "
    "identify a blocker; skip the section otherwise — don't fabricate). "
    "If both inputs are empty, post a one-line acknowledgement instead "
    "of staying silent — briefings have a fixed cadence and the "
    "principal expects proof-of-life. "
    "Calendar source: the google connector — from the composition dir "
    "run node apm_modules/_local/google/scripts/connector.mjs call "
    "calendar.list_events with a time_min arg (RFC3339 UTC for local "
    "midnight); there is no time_max, so filter to today client-side. "
    "Keep it under 200 words. No filler ('Good morning!', 'Have a great "
    "day!'). The principal sees this every weekday; preserve their "
    "attention. "
    "This is informational — don't offer to do work autonomously here. "
    "If the principal wants to act they'll reply in Slack and the "
    "heartbeat approval flow takes it from there."
)


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


def render_prompt(today: Optional[date] = None) -> str:
    if today is None:
        today = date.today()
    delivery, jid = delivery_config()
    return PROMPT_TEMPLATE.format(
        date=today.isoformat(),
        day_of_week=today.strftime("%A"),
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
    body = {
        "kind": "morning-briefing",
        "date": today.isoformat(),
        "day_of_week": today.strftime("%A"),
        # Echoed so the gateway log says where a given fire was meant to land;
        # without it a briefing that vanished is indistinguishable from one that
        # was delivered somewhere nobody was looking.
        "delivery": delivery,
        "instructions": render_prompt(today),
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
