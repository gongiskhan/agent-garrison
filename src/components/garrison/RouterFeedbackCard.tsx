"use client";

/**
 * The dimension feedback card (§8.2) — the Garrison home page's verdict surface.
 *
 * What it replaces: a "Right" button and a LINK to Muster labelled "Wrong -
 * correct it". The link was the whole problem — the correction lived on another
 * page, so the only answer this card could actually collect was agreement, and
 * agreement is the one answer that must never drift the policy.
 *
 * So the correction happens HERE, and it is a correction rather than a
 * complaint: each dimension the decision resolved is its own tap target, and
 * tapping one opens that dimension's REAL options — the gateway's live routing
 * vocabulary through the shell proxy, the same list the edge validates a value
 * against. Two taps, no typing, no navigation.
 *
 * Free text appears only when the gateway is not answering: no vocabulary to
 * offer is a reason to accept a typed value, not a reason to block a verdict.
 *
 * There is deliberately no free-text NOTE. `decision-verdicts.ts` keeps the
 * queue record free of user prose (nothing to redact, which is what makes the
 * feed's no-user-content posture hold) and `sanitizeCorrection` drops any key
 * outside the run spec — so a note box here would collect prose that silently
 * never left the browser.
 *
 * Phone-first: this renders in a dashboard panel on a 390px page, so the chips
 * wrap, every control clears the 24px tap floor, and nothing is hidden behind a
 * hover.
 *
 * Presentational and fully controlled by props (its own state is only the typed
 * fallback), so the vocabulary it renders is assertable without a DOM —
 * tests/feedback-card.test.ts.
 */

// The namespace import is load-bearing for the TEST, not for Next: vitest's
// esbuild compiles this file with the classic JSX runtime, so a render under
// react-dom/server needs React in scope (the tests/claude-chat-rail.test.ts
// convention). Next's automatic runtime simply ignores it.
import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CorrectionField } from "@/lib/decision-verdicts";
import {
  correctableFields,
  fieldLabel,
  LEVEL_IS_CORRECTABLE,
  optionsForField,
  resolvedSpec,
  type FeedbackDecision,
  type FieldOption,
  type RouteOptionsResponse
} from "@/lib/decision-feedback";
import styles from "./GarrisonHome.module.css";

export function RouterFeedbackCard({
  decision,
  options,
  openField,
  failed,
  onOpenField,
  onConfirm,
  onWrong,
  onCorrect
}: {
  decision: FeedbackDecision;
  /** null while the routing vocabulary has not been read yet. */
  options: RouteOptionsResponse | null;
  openField: CorrectionField | null;
  failed?: boolean;
  onOpenField: (field: CorrectionField) => void;
  onConfirm: () => void;
  onWrong: () => void;
  onCorrect: (field: CorrectionField, value: string) => void;
}) {
  const spec = resolvedSpec(decision);
  const fields = correctableFields(decision);
  const choices = openField ? optionsForField(openField, options, decision) : [];

  return (
    <div className={styles.routerAsk} data-testid="router-feedback-card">
      <div className={styles.routerAskHead}>Was this route right?</div>
      {/* The one-line decision IS the set of tap targets: reading it and
          correcting it are the same gesture. */}
      <div className={styles.routerDims}>
        {fields.map((field) => (
          <button
            key={field}
            type="button"
            className={clsx(styles.routerDim, openField === field && styles.routerDimOpen)}
            aria-expanded={openField === field}
            data-testid={`router-dim-${field}`}
            onClick={() => onOpenField(field)}
          >
            <span>{fieldLabel(field)}</span>
            <b>
              {spec[field]}
              {/* The level rides with the duty it belongs to: it is not in the
                  correction vocabulary, so its own tap target would collect an
                  answer the queue drops. */}
              {field === "duty" && !LEVEL_IS_CORRECTABLE && decision.level != null
                ? ` L${decision.level}`
                : ""}
            </b>
          </button>
        ))}
      </div>

      {openField ? (
        <DimensionMenu
          // Remounting per dimension is what discards a half-typed value for the
          // dimension the user just moved away from.
          key={openField}
          field={openField}
          ran={spec[openField] ?? null}
          options={options}
          choices={choices}
          onCorrect={onCorrect}
        />
      ) : null}

      <div className={styles.routerAskActions}>
        <button type="button" data-testid="router-verdict-right" onClick={onConfirm}>
          Right
        </button>
        {/* A "wrong" that names no dimension is a weaker signal, not a
            non-signal: the user knows the call was bad without knowing which
            axis caused it, and refusing that answer would just lose it. */}
        <button type="button" data-testid="router-verdict-wrong" onClick={onWrong}>
          Wrong
        </button>
        <Link href="/muster?section=decisions">More detail</Link>
      </div>
      {failed ? <span className={styles.routerMenuNote}>could not record that</span> : null}
    </div>
  );
}

/**
 * One dimension's options. Picking a value IS the verdict — the tap that opened
 * this menu already said the route was wrong, and asking for a second confirming
 * tap is how a one-tap correction becomes a form nobody fills in.
 *
 * The typed input is the gateway-is-down path only: `choices` is empty exactly
 * when there is no vocabulary to offer, and a correction the user cannot express
 * is worse than one the edge might refuse.
 */
function DimensionMenu({
  field,
  ran,
  options,
  choices,
  onCorrect
}: {
  field: CorrectionField;
  /** What this dimension actually resolved to, as the placeholder. */
  ran: string | null;
  options: RouteOptionsResponse | null;
  choices: FieldOption[];
  onCorrect: (field: CorrectionField, value: string) => void;
}) {
  const [typed, setTyped] = useState("");

  return (
    <div className={styles.routerMenu} data-testid={`router-menu-${field}`}>
      <div className={styles.routerMenuHead}>What should the {fieldLabel(field)} have been?</div>
      {options === null ? (
        <span className={styles.routerMenuNote}>reading the routing vocabulary</span>
      ) : choices.length ? (
        <div className={styles.routerMenuRows}>
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={styles.routerMenuRow}
              onClick={() => onCorrect(field, choice.value)}
            >
              <span>{choice.value}</span>
              {choice.detail ? <em>{choice.detail}</em> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.routerTyped}>
          <input
            type="text"
            value={typed}
            aria-label={`corrected ${fieldLabel(field)}`}
            placeholder={ran ?? "what it should have been"}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="button" disabled={!typed.trim()} onClick={() => onCorrect(field, typed.trim())}>
            Record
          </button>
        </div>
      )}
      {options && !options.available ? (
        <span className={styles.routerMenuNote}>
          {options.reason ?? "the gateway is not answering - type the value instead"}
        </span>
      ) : null}
    </div>
  );
}
