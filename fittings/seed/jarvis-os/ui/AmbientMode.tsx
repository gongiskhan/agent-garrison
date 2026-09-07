"use client";

// ---------------------------------------------------------------------------
// Ambient mode v3 — "the shell dimmed to rest" (jarvis-hud-redesign-brief.md).
//
// Design law: Garrison's shell. The shell is light editorial paper, but its
// one real dark surface — `.term` in src/app/globals.css — defines the dark
// language this screen extends. Every value below is lifted from there, not
// invented:  bg #0f1612 · card #131b16 (one step toward the .term header
// #1f2a25) · hairline #283731 · text #d7e3dc · mute #9fb7aa · accent #74a385
// (the .term stdout sage — the dark-surface voice of --sage).
//
// Hard rules honored: one accent (the next-tick countdown, the single
// breathing element), greyscale everything else, 1px hairline borders, no
// glows, zero emoji (icons are monochrome lucide), no sci-fi decoration,
// opaque background (kills the terminal bleed-through), equal-height grid.
// Motion: staggered 300ms fade+rise entrance (CSS — `motion` isn't in this
// fitting's stack; same curve and timing as the brief), the countdown's 3.5s
// opacity breath, and nothing else. prefers-reduced-motion strips all three.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  CalendarDays, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain,
  CloudSun, Columns3, Mail, Music, Pause, Play, SkipBack, SkipForward,
  Snowflake, Sun, Activity,
} from "lucide-react";
import type { MusicState } from "./MusicWidget";

export type AmbientData = {
  weather?: {
    temp: number; code: number | null;
    today: { max: number; min: number; code: number | null };
    tomorrow: { max: number; min: number; code: number | null };
  } | null;
  agenda?: { events: Array<{ when: string; time: string; title: string }> } | null;
  emails?: { unread: number; items: Array<{ from: string; subject: string; unread: boolean }> } | null;
  board?: { columns: Array<{ name: string; cards: string[] }> } | null;
};

export type AmbientOperative = {
  gateway: { ok: boolean; mode?: string | null; uptimeMs?: number | null; sessions?: number | null; channels?: number | null };
  voice: { ok: boolean; ready?: boolean };
  souls: string[];
} | null;

function WeatherIcon({ code, size = 16 }: { code: number | null; size?: number }) {
  const props = { size, strokeWidth: 1.6 };
  if (code == null) return <Cloud {...props} />;
  if (code === 0) return <Sun {...props} />;
  if (code <= 2) return <CloudSun {...props} />;
  if (code === 3) return <Cloud {...props} />;
  if (code === 45 || code === 48) return <CloudFog {...props} />;
  if (code <= 57) return <CloudDrizzle {...props} />;
  if (code <= 67) return <CloudRain {...props} />;
  if (code <= 77) return <Snowflake {...props} />;
  if (code <= 82) return <CloudRain {...props} />;
  return <CloudLightning {...props} />;
}

function wmoLabel(code: number | null): string {
  if (code == null) return "";
  if (code === 0) return "céu limpo";
  if (code <= 2) return "pouco nublado";
  if (code === 3) return "nublado";
  if (code === 45 || code === 48) return "nevoeiro";
  if (code <= 57) return "chuvisco";
  if (code <= 67) return "chuva";
  if (code <= 77) return "neve";
  if (code <= 82) return "aguaceiros";
  return "trovoada";
}

function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "menos de 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

function fmtMmSs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTrackMs(ms?: number | null): string {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function AmbientMode({
  data,
  music,
  operative,
  idleSince,
  nextTickAt,
  onMusicCmd,
  onDismiss,
}: {
  data: AmbientData | null;
  music: MusicState | null;
  operative: AmbientOperative;
  idleSince: number;
  nextTickAt: number;
  onMusicCmd: (action: "pause" | "resume" | "next" | "previous") => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const dateLine = new Intl.DateTimeFormat("pt-PT", { weekday: "long", day: "numeric", month: "long" }).format(now);
  const w = data?.weather;
  const gw = operative?.gateway;

  let delay = 0;
  const enter = () => ({ animationDelay: `${(delay += 60) / 1000}s` });

  return (
    <div className="am3" onPointerDown={(e) => { e.stopPropagation(); onDismiss(); }}>
      <div className="am3-col" onPointerDown={(e) => e.stopPropagation()}>
        {/* Zona A — hero */}
        <header className="am3-hero am3-enter" style={enter()}>
          <div className="am3-clock">
            {hh}
            <span className="am3-colon">:</span>
            {mm}
          </div>
          <div className="am3-date">{dateLine}</div>
          <div className="am3-status">
            EM STANDBY · IDLE HÁ {fmtDur(now.getTime() - idleSince).toUpperCase()} · PRÓXIMO TICK{" "}
            <span className="am3-tick">{fmtMmSs(nextTickAt - now.getTime())}</span>
          </div>
        </header>

        {/* Zona B — grelha */}
        <div className="am3-grid">
          <section className="am3-card am3-enter" style={enter()}>
            <header className="am3-head"><WeatherIcon code={w?.code ?? null} size={14} /><h3>tempo · lisboa</h3></header>
            {w ? (
              <>
                <div className="am3-w-now">
                  <span className="am3-w-temp">{w.temp}°</span>
                  <span className="am3-w-cond">{wmoLabel(w.code)}</span>
                </div>
                <div className="am3-rows">
                  <div className="am3-row"><span>hoje</span><b>{w.today.min}° – {w.today.max}°</b></div>
                  <div className="am3-row"><span>amanhã</span><b>{w.tomorrow.min}° – {w.tomorrow.max}°</b></div>
                </div>
              </>
            ) : <div className="am3-empty">sem dados</div>}
          </section>

          <section className="am3-card am3-enter" style={enter()}>
            <header className="am3-head"><CalendarDays size={14} strokeWidth={1.6} /><h3>agenda</h3></header>
            {!data?.agenda || data.agenda.events.length === 0 ? (
              <div className="am3-empty">dia livre</div>
            ) : (
              data.agenda.events.map((e, i) => (
                <div className="am3-event" key={i}>
                  <span className="am3-event-when">{e.when === "amanhã" ? "amanhã · " : ""}{e.time}</span>
                  <span className="am3-event-title">{e.title}</span>
                </div>
              ))
            )}
          </section>

          <section className="am3-card am3-enter" style={enter()}>
            <header className="am3-head">
              <Mail size={14} strokeWidth={1.6} />
              <h3>email</h3>
              {data?.emails && data.emails.unread > 0 ? (
                <span className="am3-count">{data.emails.unread} novos</span>
              ) : null}
            </header>
            {!data?.emails || data.emails.items.length === 0 ? (
              <div className="am3-empty">caixa limpa</div>
            ) : (
              data.emails.items.map((m, i) => (
                <div className={`am3-mail${m.unread ? " is-unread" : ""}`} key={i}>
                  <span className="am3-mail-from">{m.from}</span>
                  <span className="am3-mail-subject">{m.subject}</span>
                </div>
              ))
            )}
          </section>

          <section className="am3-card am3-enter" style={enter()}>
            <header className="am3-head"><Columns3 size={14} strokeWidth={1.6} /><h3>trello</h3></header>
            {!data?.board ? (
              <div className="am3-empty">sem board</div>
            ) : (
              <div className="am3-cols">
                {data.board.columns.map((c, i) => (
                  <div className="am3-boardcol" key={i}>
                    <span className="am3-boardcol-name">{c.name}</span>
                    {c.cards.length === 0 && <span className="am3-empty">vazio</span>}
                    {c.cards.map((t, j) => (
                      <span className="am3-chip" key={j}>{t}</span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Zona C — estado do Jarvis (dados reais do gateway/voz; campos sem
              fonte pronta ficam em estado neutro — nunca números inventados) */}
          <section className="am3-card am3-enter" style={enter()}>
            <header className="am3-head"><Activity size={14} strokeWidth={1.6} /><h3>jarvis</h3></header>
            <div className="am3-rows">
              <div className="am3-row">
                <span>operative</span>
                <b>{gw ? (gw.ok ? "online" : "offline") : "—"}{gw?.uptimeMs != null ? ` · ${fmtDur(gw.uptimeMs)}` : ""}</b>
              </div>
              <div className="am3-row">
                <span>sessões · canais</span>
                <b>{gw?.sessions ?? "—"} · {gw?.channels ?? "—"}</b>
              </div>
              <div className="am3-row">
                <span>souls</span>
                <b>{operative?.souls?.length ?? "—"}</b>
              </div>
              <div className="am3-row">
                <span>voz</span>
                <b>{operative ? (operative.voice.ready ? "pronta" : operative.voice.ok ? "a aquecer" : "offline") : "—"}</b>
              </div>
              {/* TODO: última ação / lastSummary — sem fonte pronta no gateway;
                  fica neutro em vez de decorar com dados fabricados. */}
              <div className="am3-row"><span>última ação</span><b>—</b></div>
            </div>
          </section>
        </div>

        {/* now playing — tira fina, mesma linguagem de cartão */}
        {music?.available && music.track ? (
          <div className="am3-card am3-strip am3-enter" style={enter()}>
            <Music size={14} strokeWidth={1.6} className="am3-strip-icon" />
            <span className="am3-strip-track">{music.track}</span>
            <span className="am3-strip-artist">{music.artist}</span>
            <span className="am3-strip-time">
              {fmtTrackMs(music.progress_ms)} / {fmtTrackMs(music.duration_ms)}
            </span>
            <span className="am3-strip-controls">
              <button className="am3-strip-btn" onClick={() => onMusicCmd("previous")} aria-label="anterior"><SkipBack size={13} strokeWidth={1.6} /></button>
              <button className="am3-strip-btn" onClick={() => onMusicCmd(music.is_playing ? "pause" : "resume")} aria-label={music.is_playing ? "pausa" : "tocar"}>
                {music.is_playing ? <Pause size={13} strokeWidth={1.6} /> : <Play size={13} strokeWidth={1.6} />}
              </button>
              <button className="am3-strip-btn" onClick={() => onMusicCmd("next")} aria-label="seguinte"><SkipForward size={13} strokeWidth={1.6} /></button>
            </span>
          </div>
        ) : null}

        <footer className="am3-hint">diz «hey jarvis» ou toca no ecrã</footer>
      </div>
    </div>
  );
}
