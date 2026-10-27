import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { NetSession, NetworkSettings } from './protocol';
import { createNetSession } from './session';

/** The play session's relay connection; tests and hosts can provide one directly. */
export const NetSessionContext = createContext<NetSession | null>(null);

/** The play session's relay connection; null in single-player games and outside a level runtime. */
export const useNetSession = (): NetSession | null => useContext(NetSessionContext);

const subscribeNothing = () => () => undefined;

/** Re-renders when the session's status, peers or host change; returns a version counter. */
export const useNetChanges = (session: NetSession | null): number => {
    const [version, setVersion] = useState(0);
    useEffect(() => session?.onChange(() => setVersion(value => value + 1)), [session]);
    return version;
};

/** The session's status ('disconnected' when there is none), kept current. */
export const useNetStatus = (session: NetSession | null): string =>
    useSyncExternalStore(session ? session.onChange : subscribeNothing, () => session?.status() ?? 'disconnected', () => 'disconnected');

interface NetSessionProviderProps {
    settings: NetworkSettings;
    gameId: string;
    name: string;
    children?: React.ReactNode;
}

/** Connects to the relay while multiplayer is enabled; closes the connection on unmount or settings change. */
export const NetSessionProvider: React.FC<NetSessionProviderProps> = ({ settings, gameId, name, children }) => {
    const [session, setSession] = useState<NetSession | null>(null);
    const { enabled, serverUrl, room, maxPlayers } = settings;
    useEffect(() => {
        if (!enabled) {
            setSession(null);
            return undefined;
        }
        const created = createNetSession({ settings: { enabled, serverUrl, room, maxPlayers }, gameId, name });
        setSession(created);
        return () => {
            created.close();
            setSession(current => (current === created ? null : current));
        };
    }, [enabled, serverUrl, room, maxPlayers, gameId, name]);
    return <NetSessionContext.Provider value={session}>{children}</NetSessionContext.Provider>;
};
