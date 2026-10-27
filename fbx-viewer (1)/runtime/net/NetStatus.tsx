import React from 'react';
import { Users, WifiOff } from 'lucide-react';
import { useNetChanges, useNetSession } from './NetSessionContext';

/** A small corner badge in multiplayer games: connection state, player count and whether this player hosts. */
export const NetStatus: React.FC = () => {
    const session = useNetSession();
    useNetChanges(session);
    if (!session) return null;
    const status = session.status();
    const connected = status === 'connected';
    return (
        <div
            className={`pointer-events-none absolute top-2 left-2 z-30 flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold ${connected ? 'bg-black/50 text-emerald-300' : 'bg-red-950/80 text-red-200'}`}
            title={session.statusMessage() || undefined}
            role="status"
        >
            {connected ? <Users size={11} /> : <WifiOff size={11} />}
            {connected
                ? `${session.peers().length + 1} player${session.peers().length ? 's' : ''}${session.isHost() ? ' · host' : ''}`
                : status === 'connecting' ? 'Connecting...' : session.statusMessage() || 'Offline'}
        </div>
    );
};
