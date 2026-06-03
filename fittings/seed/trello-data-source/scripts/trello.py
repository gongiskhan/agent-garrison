"""Trello client for the Garrison Trello Fitting.

Standalone — stdlib-only. Reads TRELLO_KEY / TRELLO_TOKEN from env.
Raises TrelloError on failure so callers can decide whether to
continue (e.g. skip one call but finish a tick).

Usage:
    python trello.py --probe                # health check, prints "boardOk"
    python trello.py lists                   # list the board's lists (id, name)
    python trello.py list <list_id>         # list open cards in a list
    python trello.py create <list_id> <name>
    python trello.py archive <card_id>
    python trello.py move <card_id> <to_list_id>
    python trello.py comment <card_id> <text>
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable


class TrelloError(RuntimeError):
    pass


@dataclass
class Card:
    id: str
    name: str
    desc: str
    id_list: str
    closed: bool
    labels: list[str]
    date_last_activity: datetime | None
    url: str

    @classmethod
    def from_api(cls, raw: dict[str, Any]) -> "Card":
        last = raw.get("dateLastActivity")
        return cls(
            id=raw["id"],
            name=raw["name"],
            desc=raw.get("desc", "") or "",
            id_list=raw.get("idList", ""),
            closed=bool(raw.get("closed", False)),
            labels=[lbl.get("name", "") for lbl in raw.get("labels", []) if lbl.get("name")],
            date_last_activity=datetime.fromisoformat(last.replace("Z", "+00:00")) if last else None,
            url=raw.get("url", ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "desc": self.desc,
            "id_list": self.id_list,
            "closed": self.closed,
            "labels": self.labels,
            "date_last_activity": self.date_last_activity.isoformat() if self.date_last_activity else None,
            "url": self.url,
        }


def _credentials() -> tuple[str, str]:
    key = os.environ.get("TRELLO_KEY", "")
    token = os.environ.get("TRELLO_TOKEN", "")
    if not key or not token:
        raise TrelloError("TRELLO_KEY / TRELLO_TOKEN not configured")
    return key, token


class TrelloClient:
    """Thin REST client. Stdlib-only."""

    def __init__(self, key: str | None = None, token: str | None = None, timeout: float = 10.0):
        k, t = _credentials()
        self.key = key or k
        self.token = token or t
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        body: dict | None = None,
    ) -> Any:
        params = {**(params or {}), "key": self.key, "token": self.token}
        qs = urllib.parse.urlencode(params)
        url = f"https://api.trello.com/1{path}?{qs}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300] if hasattr(e, "read") else str(e)
            raise TrelloError(f"Trello {method} {path} -> {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise TrelloError(f"Trello {method} {path} unreachable: {e.reason}") from e

    # ---- Reads --------------------------------------------------------

    def list_cards(self, list_id: str, *, filter: str = "open", limit: int = 1000) -> list[Card]:
        raw = self._request(
            "GET",
            f"/lists/{list_id}/cards",
            params={
                "fields": "id,name,desc,idList,closed,labels,dateLastActivity,url",
                "filter": filter,
                "limit": limit,
            },
        )
        return [Card.from_api(c) for c in raw]

    def list_cards_open(self, list_id: str) -> list[Card]:
        return self.list_cards(list_id, filter="open")

    def list_cards_closed(self, list_id: str) -> list[Card]:
        return self.list_cards(list_id, filter="closed")

    def board_labels(self, board_id: str) -> dict[str, str]:
        raw = self._request("GET", f"/boards/{board_id}/labels", params={"limit": 100})
        return {lbl["name"]: lbl["id"] for lbl in raw if lbl.get("name")}

    def board_lists(self, board_id: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/boards/{board_id}/lists", params={"fields": "id,name,closed"}) or []

    # ---- Writes -------------------------------------------------------

    def create_card(
        self,
        list_id: str,
        name: str,
        desc: str = "",
        label_ids: Iterable[str] = (),
        pos: str = "bottom",
    ) -> Card:
        body: dict[str, Any] = {"name": name, "desc": desc, "idList": list_id, "pos": pos}
        ids = list(label_ids)
        if ids:
            body["idLabels"] = ids
        raw = self._request("POST", "/cards", body=body)
        return Card.from_api(raw)

    def update_card(self, card_id: str, **fields: Any) -> Card:
        raw = self._request("PUT", f"/cards/{card_id}", body=fields)
        return Card.from_api(raw)

    def archive_card(self, card_id: str) -> Card:
        return self.update_card(card_id, closed=True)

    def reopen_card(self, card_id: str, to_list_id: str) -> Card:
        return self.update_card(card_id, closed=False, idList=to_list_id)

    def move_card(self, card_id: str, to_list_id: str) -> Card:
        return self.update_card(card_id, idList=to_list_id)

    def add_comment(self, card_id: str, text: str) -> None:
        self._request("POST", f"/cards/{card_id}/actions/comments", params={"text": text})

    def ensure_label(self, board_id: str, name: str, color: str = "blue") -> str:
        labels = self.board_labels(board_id)
        if name in labels:
            return labels[name]
        raw = self._request("POST", "/labels", body={"name": name, "color": color, "idBoard": board_id})
        return raw["id"]


# ---- CLI ----------------------------------------------------------------


def _probe() -> int:
    board_id = os.environ.get("TRELLO_BOARD_ID", "")
    if not board_id:
        print("TRELLO_BOARD_ID not configured", file=sys.stderr)
        return 1
    try:
        client = TrelloClient()
        lists = client.board_lists(board_id)
    except TrelloError as e:
        print(str(e), file=sys.stderr)
        return 1
    if not isinstance(lists, list):
        print("unexpected board_lists response shape", file=sys.stderr)
        return 1
    print("boardOk")
    return 0


def _print_cards(cards: list[Card]) -> None:
    print(json.dumps([c.to_dict() for c in cards], ensure_ascii=False, indent=2))


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0

    cmd = argv[1]
    try:
        if cmd == "--probe":
            return _probe()

        client = TrelloClient()

        if cmd == "lists":
            board_id = os.environ.get("TRELLO_BOARD_ID", "")
            if not board_id:
                print("TRELLO_BOARD_ID not configured", file=sys.stderr)
                return 1
            lists = [lst for lst in client.board_lists(board_id) if not lst.get("closed")]
            print(json.dumps(lists, ensure_ascii=False, indent=2))
            return 0

        if cmd == "list":
            if len(argv) < 3:
                print("usage: list <list_id>", file=sys.stderr)
                return 2
            _print_cards(client.list_cards_open(argv[2]))
            return 0

        if cmd == "create":
            if len(argv) < 4:
                print("usage: create <list_id> <name> [desc]", file=sys.stderr)
                return 2
            list_id, name = argv[2], argv[3]
            desc = argv[4] if len(argv) >= 5 else ""
            card = client.create_card(list_id, name, desc=desc)
            print(json.dumps(card.to_dict(), ensure_ascii=False))
            return 0

        if cmd == "archive":
            if len(argv) < 3:
                print("usage: archive <card_id>", file=sys.stderr)
                return 2
            card = client.archive_card(argv[2])
            print(json.dumps(card.to_dict(), ensure_ascii=False))
            return 0

        if cmd == "move":
            if len(argv) < 4:
                print("usage: move <card_id> <to_list_id>", file=sys.stderr)
                return 2
            card = client.move_card(argv[2], argv[3])
            print(json.dumps(card.to_dict(), ensure_ascii=False))
            return 0

        if cmd == "comment":
            if len(argv) < 4:
                print("usage: comment <card_id> <text>", file=sys.stderr)
                return 2
            client.add_comment(argv[2], argv[3])
            print("ok")
            return 0

        print(f"unknown command: {cmd}", file=sys.stderr)
        return 2
    except TrelloError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
