"use client";

import { useCallback, useMemo } from "react";
import { useWallet } from "@/hooks/useWallet";
import { getAnonId } from "@/lib/anon";
import type { Colony, GameState, Player } from "@/lib/types";

export interface PlayerIdentitySnapshot {
  wallet: string | null;
  anonymousId: string;
}

export interface PlayerIdentity extends PlayerIdentitySnapshot {
  snapshot: PlayerIdentitySnapshot;
  ready: boolean;
  connected: boolean;
  authenticated: boolean;
  short: string;
  name: string | null;
  identityNotice: string;
  ensureWallet: () => Promise<string>;
}

export function usePlayerIdentity(): PlayerIdentity {
  const { wallet, connect, identityNotice } = useWallet();
  const anonymousId = useMemo(() => getAnonId(), []);
  const ensureWallet = useCallback(async () => {
    if (wallet.authenticated && wallet.pubkey) return wallet.pubkey;
    return connect();
  }, [connect, wallet.authenticated, wallet.pubkey]);
  const authenticatedWallet = wallet.authenticated ? wallet.pubkey : null;
  const snapshot = useMemo<PlayerIdentitySnapshot>(
    () => ({ wallet: authenticatedWallet, anonymousId }),
    [anonymousId, authenticatedWallet],
  );

  return {
    // A detected/connected address is not an authority until the login
    // challenge has been signed and the HttpOnly session has been created.
    ...snapshot,
    snapshot,
    ready: wallet.ready,
    connected: wallet.connected,
    authenticated: wallet.authenticated,
    short: wallet.short,
    name: wallet.name,
    identityNotice,
    ensureWallet,
  };
}

export function identityWithWallet(identity: PlayerIdentitySnapshot, wallet: string): PlayerIdentitySnapshot {
  return { wallet, anonymousId: identity.anonymousId };
}

export function findIdentityPlayer(
  players: Player[] | null | undefined,
  identity: PlayerIdentitySnapshot,
): Player | undefined {
  if (identity.wallet) {
    const walletPlayer = (players ?? []).find((player) => player.wallet === identity.wallet);
    if (walletPlayer) return walletPlayer;
  }
  return (players ?? []).find((player) => (
    !player.wallet
    && Boolean(identity.anonymousId)
    && player.anonymousId === identity.anonymousId
  ));
}

export function findIdentityColony(
  game: GameState | null | undefined,
  identity: PlayerIdentitySnapshot,
): Colony | undefined {
  if (!game) return undefined;
  if (identity.wallet) {
    const walletColony = (game.colonies ?? []).find((colony) => colony.playerWallet === identity.wallet);
    if (walletColony) return walletColony;
  }

  const player = findIdentityPlayer(game.players, identity);
  if (player?.playerId) {
    const linkedColony = (game.colonies ?? []).find((colony) => (
      colony.playerId === player.playerId
      && (player.wallet ? colony.playerWallet === player.wallet || !colony.playerWallet : !colony.playerWallet)
    ));
    if (linkedColony) return linkedColony;
  }

  return (game.colonies ?? []).find((colony) => (
    !colony.playerWallet
    && Boolean(identity.anonymousId)
    && colony.playerAnonymousId === identity.anonymousId
  ));
}

export function isIdentityHost(game: GameState | null | undefined, identity: PlayerIdentitySnapshot): boolean {
  if (!game) return false;
  if (game.owner?.wallet) return Boolean(identity.wallet && game.owner.wallet === identity.wallet);
  if (game.owner?.anonymousId) return game.owner.anonymousId === identity.anonymousId;
  return Boolean(findIdentityPlayer(game.players, identity)?.isHost);
}

export function legacyAnonymousIdForPlayer(
  player: Player | null | undefined,
  identity: PlayerIdentitySnapshot,
): string | undefined {
  if (player?.wallet || !identity.anonymousId) return undefined;
  return player?.anonymousId === identity.anonymousId ? identity.anonymousId : undefined;
}

export function legacyAnonymousIdForColony(
  colony: Colony | null | undefined,
  identity: PlayerIdentitySnapshot,
): string | undefined {
  if (colony?.playerWallet || !identity.anonymousId) return undefined;
  return colony?.playerAnonymousId === identity.anonymousId ? identity.anonymousId : undefined;
}

export function legacyAnonymousIdForHost(
  game: GameState | null | undefined,
  identity: PlayerIdentitySnapshot,
): string | undefined {
  if (!game || game.owner?.wallet || !identity.anonymousId) return undefined;
  if (game.owner?.anonymousId === identity.anonymousId) return identity.anonymousId;
  return legacyAnonymousIdForPlayer(findIdentityPlayer(game.players, identity), identity);
}
