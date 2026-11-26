import React, { useState } from 'react';
import { OfflineIcon, UsersIcon } from '../../components/UI/Icons';
import { useNetChanges, useNetSession } from './NetSessionContext';
import type { NetSession } from './protocol';

/** Multiplayer connection status and explicit, session-only host authentication. */
export const NetStatus: React.FC = () => {
    const session = useNetSession();
    useNetChanges(session);
    const [draft, setDraft] = useState<{ session: NetSession; token: string; error: string } | null>(null);
    if (!session) return null;
    const status = session.status();
    const connected = status === 'connected';
    // Never offer a draft credential to a different relay/session after settings change.
    const active = draft?.session === session ? draft : null;
    const apply = (token: string) => {
        const error = session.setHostToken(token);
        setDraft(error ? { session, token: '', error } : null);
    };
    return (
        <div
            className="absolute top-2 left-2 z-30 flex flex-col items-start gap-1 cursor-auto text-[10px] font-bold text-white"
            onPointerDown={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
            onKeyUp={event => event.stopPropagation()}
        >
            <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded ${connected ? 'bg-black/50 text-emerald-300' : 'bg-red-950/80 text-red-200'}`}
                title={session.statusMessage() || undefined}
                role="status"
            >
                {connected ? <UsersIcon size={11} /> : <OfflineIcon size={11} />}
                {connected
                    ? `${session.peers().length + 1} player${session.peers().length ? 's' : ''}${session.isHost() ? ' · host' : ''}`
                    : status === 'connecting' ? 'Connecting...' : session.statusMessage() || 'Offline'}
            </div>
            {active ? (
                <form className="flex flex-col gap-1 rounded bg-black/90 p-2" onSubmit={event => { event.preventDefault(); if (active.token) apply(active.token); }}>
                    <label htmlFor="auvra-host-credential">Host credential (this session only)</label>
                    <input
                        id="auvra-host-credential"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={128}
                        value={active.token}
                        onChange={event => setDraft({ session, token: event.target.value, error: '' })}
                        className="rounded bg-gray-800 px-2 py-1 text-white"
                    />
                    {active.error && <span role="alert" className="text-red-300">{active.error}</span>}
                    <div className="flex gap-2">
                        <button type="submit" disabled={!active.token} className="rounded bg-indigo-700 px-2 py-1 disabled:opacity-50">Host room</button>
                        <button type="button" onClick={() => apply('')} className="rounded bg-gray-700 px-2 py-1">Join as player</button>
                        <button type="button" onClick={() => setDraft(null)} className="rounded bg-gray-700 px-2 py-1">Cancel</button>
                    </div>
                </form>
            ) : (!connected || !session.isHost()) && (
                <button type="button" className="rounded bg-black/80 px-2 py-1"
                    onClick={() => {
                        if (document.pointerLockElement) document.exitPointerLock();
                        setDraft({ session, token: '', error: '' });
                    }}>
                    Host credentials
                </button>
            )}
        </div>
    );
};
