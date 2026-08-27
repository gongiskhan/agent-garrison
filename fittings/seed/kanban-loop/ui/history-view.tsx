// The frozen History view: the pre-Conversations board, preserved.
//
// The Conversations migration (2026-08-26) rebuilt the board as five state
// columns and froze every legacy card as read-only history. loadAllCards asks
// the state service for frozen:"0", so those records are invisible on the live
// board BY DESIGN — this surface is the one door to them, and GET /history is
// the one endpoint that reads them.
//
// It reuses the board's own column chrome (.board-scroll / .board / .list /
// .card) so the layout, the horizontal scroll and the 84vw phone columns come
// from one place; `.history` adds the muted treatment that says "record, not
// work". Nothing here can write: there is no drag layer, no composer, no
// action row, and the state service refuses every write on a frozen card
// anyway (409 card-frozen) except DELETE.

import { useCallback, useEffect, useState } from "react";
import { api, type FrozenCardSummary, type HistoryView as HistoryData } from "./api";

// Date only: a frozen record's exact minute is noise, and the columns are
// sorted newest-first so the ordering already carries the fine detail.
//
// It is the card's OWN last activity, never frozen.at: the migration froze all
// 263 records in one pass, so every frozen.at is the same day and a column of
// them would say nothing at all.
function fmtFrozenDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function HistoryCard({ card, onOpen }: { card: FrozenCardSummary; onOpen: (id: string) => void }) {
  const when = fmtFrozenDate(card.updated ?? card.created ?? card.frozen?.at ?? null);
  return (
    <button
      type="button"
      className="card history-card"
      title={`${card.title}\nlast activity ${card.updated ?? card.created ?? "unrecorded"}\nfrozen ${card.frozen?.at ?? "before the Conversations migration"}`}
      onClick={() => onOpen(card.id)}
    >
      <div className="ct">
        <span className="title">{card.title}</span>
      </div>
      <div className="cmeta">
        {card.project && <span className="chip">{card.project}</span>}
        {card.scope === "personal" && <span className="chip">personal</span>}
        {card.duty && <span className="chip">{card.duty}</span>}
        {when && <span className="hc-when">{when}</span>}
      </div>
    </button>
  );
}

export function HistoryView({ refreshKey = 0, onBack, onOpenCard }: { refreshKey?: number; onBack: () => void; onOpenCard: (id: string) => void }) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.history());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Loaded once, not polled: frozen records do not change. A delete is the one
  // thing that can, and the card modal's onChanged bumps refreshKey to re-read.
  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <div className="history">
      <div className="history-bar">
        <button type="button" className="btn" onClick={onBack}>Back to board</button>
        <p className="history-note">
          {data
            ? `${data.total} frozen record${data.total === 1 ? "" : "s"} from before the Conversations migration, under the board they were filed on. Read-only: they can be opened and deleted, not edited or moved.`
            : "The frozen pre-Conversations records, under the board they were filed on. Read-only."}
        </p>
      </div>
      {err && <div className="banner">Could not load the history: {err}</div>}
      {data && !data.legacyLayout && (
        <div className="banner info">
          This instance has no saved pre-Conversations board, so the records below are grouped by the
          list id each one carries.
        </div>
      )}
      <div className="board-scroll">
        <div className="board">
          {!data && !err && <p className="muted history-empty">Loading the frozen records…</p>}
          {data && data.lists.length === 0 && (
            <p className="muted history-empty">No frozen records - nothing was archived by the Conversations migration here.</p>
          )}
          {(data?.lists ?? []).map((list) => (
            <section key={list.id} className="list history-list">
              <div className="lh">
                <div className="lname">
                  <span className="lname-text">{list.title}</span>
                  <span className="count">{list.cards.length}</span>
                </div>
                <div className="lkind">{list.unlisted ? "unlisted · frozen" : "frozen"}</div>
              </div>
              <div className="lbody">
                {list.cards.length === 0
                  ? <div className="lempty">empty</div>
                  : list.cards.map((card) => (
                      <HistoryCard key={card.id} card={card} onOpen={onOpenCard} />
                    ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
