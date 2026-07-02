"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useQueen, EMBLEMS } from "@/lib/queen";
import { AntMarch } from "@/components/AntMarch";

export default function QueenPage() {
  const { connect } = useWallet();
  const { wallet, queen, save, abdicate } = useQueen();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [motto, setMotto] = useState("");
  const [emblem, setEmblem] = useState<string>(EMBLEMS[0]);
  const [msg, setMsg] = useState("");

  // prefill the form when editing an existing queen
  useEffect(() => {
    if (queen) {
      setName(queen.name);
      setMotto(queen.motto);
      setEmblem(queen.emblem);
    }
  }, [queen]);

  function crown() {
    if (!name.trim()) return setMsg("Your queen needs a name.");
    save({ name: name.trim().slice(0, 24), motto: motto.trim().slice(0, 48), emblem });
    setEditing(false);
    setMsg("");
  }

  // ---- not connected: a queen must be bound to a wallet ----
  if (!wallet.connected) {
    return (
      <div className="flex flex-col gap-3">
        <Header />
        <div className="glass bracket flex flex-col items-center gap-4 p-6 text-center">
          <span className="text-4xl">👑</span>
          <p className="text-sm leading-relaxed text-ink-soft">
            Every wallet may crown <b>one queen ant</b> — she carries your name into every room and match.
          </p>
          <button className="btn btn-primary" onClick={() => connect().catch((e) => setMsg(e.message))}>
            🔗 Connect Phantom to crown her
          </button>
          {msg && <p className="text-xs text-danger">{msg}</p>}
        </div>
      </div>
    );
  }

  // ---- reigning queen card ----
  if (queen && !editing) {
    return (
      <div className="flex flex-col gap-3">
        <Header />
        <div className="glass bracket overflow-hidden text-center">
          <AntMarch className="border-b-2 border-[color:var(--brd-soft)] bg-[color:var(--color-slot)] py-1.5" />
          <div className="flex flex-col items-center gap-3 p-6">
            <div className="plate grid h-20 w-20 place-items-center text-5xl">{queen.emblem}</div>
            <div>
              <p className="eyebrow">Queen of the colony</p>
              <h2 className="hud-title mt-2 text-[15px]">{queen.name}</h2>
            </div>
            {queen.motto && <p className="text-sm italic text-ink-soft">“{queen.motto}”</p>}
            <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              <span className="plate px-2.5 py-1">🔗 {wallet.short}</span>
              <span className="plate px-2.5 py-1">Reigning since {new Date(queen.crownedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => setEditing(true)}>✏️ Edit royal decree</button>
        <button
          className="btn btn-ghost !min-h-0 py-2 text-xs text-danger"
          onClick={() => { if (confirm("Abdicate? Her name and motto will be lost.")) abdicate(); }}
        >
          Abdicate the throne
        </button>
        <p className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">one queen ant per wallet</p>
      </div>
    );
  }

  // ---- crown / edit form ----
  return (
    <div className="flex flex-col gap-3">
      <Header />
      <div className="glass flex flex-col gap-4 p-4">
        <div>
          <p className="eyebrow">{queen ? "Royal decree" : "Coronation"}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {queen ? "Amend your queen's name and motto." : "Name the one queen this wallet will ever crown."}
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-ink-soft">Queen name</span>
          <input className="input" maxLength={24} placeholder="Solenopsis the Bold" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-ink-soft">Motto <span className="font-normal text-ink-faint">(optional)</span></span>
          <input className="input" maxLength={48} placeholder="The colony provides." value={motto} onChange={(e) => setMotto(e.target.value)} />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-ink-soft">Royal emblem</span>
          <div className="flex flex-wrap gap-2">
            {EMBLEMS.map((e) => (
              <button
                key={e}
                type="button"
                className={`plate grid h-12 w-12 place-items-center text-2xl transition-transform ${emblem === e ? "!border-gold shadow-[2px_2px_0_rgba(90,70,30,0.4)]" : "opacity-60"}`}
                onClick={() => setEmblem(e)}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {msg && <p className="text-sm text-danger">{msg}</p>}
        <button className="btn btn-primary" onClick={crown}>👑 {queen ? "Amend decree" : "Crown your queen"}</button>
        {editing && <button className="btn btn-ghost !min-h-0 py-2 text-sm" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      <p className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">one queen ant per wallet · stored with {wallet.short}</p>
    </div>
  );
}

function Header() {
  return (
    <div className="glass flex items-center gap-3 px-4 py-3">
      <div className="grid h-10 w-10 place-items-center rounded-md border-2 border-[color:var(--brd-strong)] bg-[color:var(--color-slot)]">
        <span className="text-xl">👑</span>
      </div>
      <div>
        <h1 className="hud-title text-[11px]">Queen Ant</h1>
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">Your royal identity</p>
      </div>
    </div>
  );
}
