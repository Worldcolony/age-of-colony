import type { Fixture, GameEvent, MatchScore } from "./types";

export function teamName(v?: string | null, fallback = "TBD"): string {
  return (v && v.trim()) || fallback;
}

const FLAGS: Record<string, string> = {
  argentina: "🇦🇷", australia: "🇦🇺", austria: "🇦🇹", belgium: "🇧🇪", brazil: "🇧🇷",
  canada: "🇨🇦", colombia: "🇨🇴", croatia: "🇭🇷", denmark: "🇩🇰", ecuador: "🇪🇨",
  egypt: "🇪🇬", england: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", france: "🇫🇷", germany: "🇩🇪", ghana: "🇬🇭",
  iran: "🇮🇷", italy: "🇮🇹", japan: "🇯🇵", mexico: "🇲🇽", morocco: "🇲🇦",
  netherlands: "🇳🇱", nigeria: "🇳🇬", norway: "🇳🇴", panama: "🇵🇦", paraguay: "🇵🇾",
  peru: "🇵🇪", poland: "🇵🇱", portugal: "🇵🇹", qatar: "🇶🇦", scotland: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  senegal: "🇸🇳", serbia: "🇷🇸", spain: "🇪🇸", sweden: "🇸🇪", switzerland: "🇨🇭",
  tunisia: "🇹🇳", turkey: "🇹🇷", uruguay: "🇺🇾", usa: "🇺🇸", wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "south korea": "🇰🇷", "south africa": "🇿🇦", "czech republic": "🇨🇿", "saudi arabia": "🇸🇦",
  "congo dr": "🇨🇩",
};
export function flag(team?: string | null): string {
  if (!team) return "⚽";
  return FLAGS[team.trim().toLowerCase()] || "⚽";
}

export function fixtureId(f: Fixture): string | number | null {
  return f?.fixtureId ?? null;
}

const KIND_ICON: Record<string, string> = {
  game_created: "🏟️", player_joined: "🙋", colony_created: "🐜", strategy_updated: "🎛️",
  game_started: "🚀", opportunity: "🎯", vote: "🗳️", info: "🔎", info_result: "💡",
  ant_agent_start: "🤖", ant_agent_vote: "🐜", agent_decision: "🧠", prediction: "📈",
  settlement: "💰", observe: "👁️", starvation: "☠️", hatch: "🥚", void: "🚫",
  markets_closed: "🔒", game_finished: "🏁", game_error: "⚠️", rally: "📣",
  recall: "🛡️", switch: "🔀",
};
export function kindIcon(kind: string): string {
  return KIND_ICON[kind] || "•";
}

const MATCH_KINDS = new Set(["game_created", "game_started", "opportunity", "markets_closed", "game_finished"]);
export function isMatchEvent(e: GameEvent): boolean {
  return MATCH_KINDS.has(e.kind);
}

export function fmtScore(score?: MatchScore | null): string {
  if (!score) return "0 – 0";
  return `${score.participant1 ?? 0} – ${score.participant2 ?? 0}`;
}

export function fmtWhen(t?: number): string {
  if (!t) return "";
  const diff = t - Date.now();
  if (diff < 0) return "started";
  const h = Math.floor(diff / 3.6e6);
  const m = Math.floor((diff % 3.6e6) / 6e4);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export function startMs(startTime?: number | string | null, startTimeIso?: string | null): number | null {
  if (typeof startTime === "number" && Number.isFinite(startTime)) return startTime;
  if (typeof startTime === "string" && startTime.trim()) {
    const numeric = Number(startTime);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(startTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (startTimeIso) {
    const parsed = Date.parse(startTimeIso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function fmtKickoff(startTime?: number | string | null, startTimeIso?: string | null): string {
  const ms = startMs(startTime, startTimeIso);
  if (!ms) return "Kickoff time TBA";

  const date = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const sameDay = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);

  if (sameDay) return `Kickoff ${time}`;
  if (isTomorrow) return `Kickoff tomorrow ${time}`;

  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  return `Kickoff ${day}, ${time}`;
}

export function fmtKickoffLine(startTime?: number | string | null, startTimeIso?: string | null): string {
  const ms = startMs(startTime, startTimeIso);
  if (!ms) return "Kickoff time TBA";
  return `${fmtKickoff(ms)} · ${fmtWhen(ms)}`;
}
