// Age of Colony — one global Phantom (Solana) identity session. The wallet
// signs a login message once; gameplay never asks for a transaction or SOL.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { accentHex, shortAddress } from "@/lib/accent";
import { useStore, type WalletState } from "@/store/game";

/* eslint-disable @typescript-eslint/no-explicit-any */
type PhantomListener = (arg?: any) => void;

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58?: () => string; toString?: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: any }>;
  disconnect: () => Promise<void>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
  on?: (event: string, cb: PhantomListener) => void;
  off?: (event: string, cb: PhantomListener) => void;
  removeListener?: (event: string, cb: PhantomListener) => void;
};

export const WALLET_IDENTITY_NOTICE = "Identity signature only — no transaction and no SOL.";

interface WalletContextValue {
  wallet: WalletState;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  identityNotice: string;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function detect(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  if (w.phantom?.solana) return w.phantom.solana as PhantomProvider;
  if (w.solana?.isPhantom) return w.solana as PhantomProvider;
  return null;
}

// Sign an arbitrary identity message with the connected Phantom wallet; returns base64.
export async function signWalletMessage(message: string): Promise<string> {
  const provider = detect();
  if (!provider?.signMessage) {
    throw new Error(`Phantom cannot sign this identity message. ${WALLET_IDENTITY_NOTICE}`);
  }
  const { signature } = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pkStr(pk: any): string | null {
  if (!pk) return null;
  if (typeof pk === "string") return pk;
  if (typeof pk.toBase58 === "function") {
    try {
      return pk.toBase58();
    } catch {
      // Fall through to the provider's string representation.
    }
  }
  if (typeof pk.toString === "function") return pk.toString();
  return null;
}

function removeProviderListener(provider: PhantomProvider, event: string, listener: PhantomListener): void {
  if (provider.off) provider.off(event, listener);
  else provider.removeListener?.(event, listener);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useStore((state) => state.wallet);
  const setWallet = useStore((state) => state.setWallet);
  const authSequence = useRef(0);
  const pendingSessionReset = useRef<Promise<void>>(Promise.resolve());

  const applyWallet = useCallback(
    (pubkey: string | null, authenticated = false) => {
      const current = useStore.getState().wallet;
      const accountChanged = current.pubkey !== pubkey;
      setWallet({
        installed: Boolean(detect()),
        connected: Boolean(pubkey),
        authenticated: Boolean(pubkey && authenticated),
        pubkey,
        accent: accentHex(pubkey),
        short: shortAddress(pubkey),
        // Never carry one queen/player name into another wallet account.
        name: accountChanged ? null : current.name,
      });
    },
    [setWallet],
  );

  const refreshSession = useCallback(async (): Promise<boolean> => {
    const requestId = ++authSequence.current;
    const pubkey = pkStr(detect()?.publicKey);
    if (!pubkey) {
      applyWallet(null, false);
      return false;
    }
    try {
      const session = await api.walletSession();
      const authenticated = session.authenticated && session.wallet === pubkey;
      if (requestId !== authSequence.current) return false;
      applyWallet(pubkey, authenticated);
      return authenticated;
    } catch {
      if (requestId !== authSequence.current) return false;
      applyWallet(pubkey, false);
      return false;
    }
  }, [applyWallet]);

  useEffect(() => {
    const provider = detect();
    let cancelled = false;
    const restoreRequestId = authSequence.current;
    setWallet({ installed: Boolean(provider), ready: false, authenticated: false });

    if (!provider) {
      setWallet({ ready: true });
      return;
    }

    const onConnect: PhantomListener = (pk) => {
      if (!cancelled) {
        applyWallet(pkStr(pk || provider.publicKey), false);
        setWallet({ ready: true });
      }
    };
    const onDisconnect: PhantomListener = () => {
      if (cancelled) return;
      authSequence.current += 1;
      applyWallet(null, false);
      setWallet({ ready: true });
      pendingSessionReset.current = api.walletLogout().then(() => undefined, () => undefined);
    };
    const onAccountChanged: PhantomListener = (pk) => {
      if (cancelled) return;
      authSequence.current += 1;
      // Clear the previous browser session immediately. The new account must
      // sign its own challenge before it receives gameplay ownership rights.
      applyWallet(pkStr(pk), false);
      setWallet({ ready: true });
      pendingSessionReset.current = api.walletLogout().then(() => undefined, () => undefined);
    };

    provider.on?.("connect", onConnect);
    provider.on?.("disconnect", onDisconnect);
    provider.on?.("accountChanged", onAccountChanged);

    void Promise.all([
      provider.connect({ onlyIfTrusted: true }).catch(() => null),
      api.walletSession().catch(() => ({ authenticated: false as const, wallet: null })),
    ]).then(([connection, session]) => {
      if (cancelled || restoreRequestId !== authSequence.current) return;
      const pubkey = pkStr(connection?.publicKey || provider.publicKey);
      const authenticated = Boolean(pubkey && session.authenticated && session.wallet === pubkey);
      applyWallet(pubkey, authenticated);
      setWallet({ ready: true });
    });

    return () => {
      cancelled = true;
      removeProviderListener(provider, "connect", onConnect);
      removeProviderListener(provider, "disconnect", onDisconnect);
      removeProviderListener(provider, "accountChanged", onAccountChanged);
    };
  }, [applyWallet, setWallet]);

  const connect = useCallback(async (): Promise<string> => {
    const provider = detect();
    if (!provider) {
      window.open("https://phantom.app/", "_blank", "noopener");
      throw new Error("Phantom wallet not found. Install it to connect.");
    }

    const requestId = ++authSequence.current;
    const connection = await provider.connect();
    const pubkey = pkStr(connection?.publicKey || provider.publicKey);
    if (!pubkey) throw new Error("Phantom connected without returning a wallet address.");
    applyWallet(pubkey, false);
    setWallet({ ready: true });

    try {
      // An accountChanged event may still be clearing the previous wallet's
      // cookie. Finish that revocation before creating the new session.
      await pendingSessionReset.current;
      const challenge = await api.walletChallenge(pubkey);
      if (challenge.wallet !== pubkey || !challenge.nonce || !challenge.message) {
        throw new Error("The wallet identity challenge was invalid.");
      }
      const signature = await signWalletMessage(challenge.message);
      const activePubkey = pkStr(provider.publicKey);
      if (requestId !== authSequence.current || activePubkey !== pubkey) {
        throw new Error("The Phantom account changed before identity verification finished.");
      }
      const session = await api.walletVerify({ wallet: pubkey, nonce: challenge.nonce, signature });
      if (
        requestId !== authSequence.current
        || pkStr(provider.publicKey) !== pubkey
        || !session.authenticated
        || session.wallet !== pubkey
      ) {
        throw new Error("The game engine could not verify this wallet identity.");
      }
      applyWallet(pubkey, true);
      return pubkey;
    } catch (error) {
      if (requestId === authSequence.current) {
        applyWallet(pkStr(provider.publicKey), false);
        await api.walletLogout().catch(() => {});
      }
      throw error;
    }
  }, [applyWallet, setWallet]);

  const disconnect = useCallback(async (): Promise<void> => {
    const provider = detect();
    authSequence.current += 1;
    applyWallet(null, false);
    const logout = api.walletLogout().then(() => undefined, () => undefined);
    pendingSessionReset.current = logout;
    await Promise.allSettled([
      logout,
      provider?.disconnect() ?? Promise.resolve(),
    ]);
  }, [applyWallet]);

  const value = useMemo<WalletContextValue>(
    () => ({ wallet, connect, disconnect, refreshSession, identityNotice: WALLET_IDENTITY_NOTICE }),
    [connect, disconnect, refreshSession, wallet],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside WalletProvider.");
  return context;
}
