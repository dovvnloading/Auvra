import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { settleAppDialog, useAppDialogs, type AppDialogRequest } from '../../utils/appDialogs';

const AppDialog: React.FC<{ request: AppDialogRequest }> = ({ request }) => {
    const [value, setValue] = useState(request.defaultValue ?? '');
    const inputRef = useRef<HTMLInputElement>(null);
    const acceptRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const messageId = useId();

    const cancel = () => settleAppDialog(request.id, request.kind === 'confirm' ? false : null);
    const accept = () => settleAppDialog(request.id, request.kind === 'prompt' ? value : request.kind === 'confirm' ? true : null);

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (request.kind === 'prompt') {
            inputRef.current?.focus();
            inputRef.current?.select();
        } else {
            acceptRef.current?.focus();
        }
        return () => previous?.focus({ preventScroll: true });
    }, [request.kind]);

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
            onKeyDown={(event) => {
                // Keys stop here so editor hotkeys behind the dialog do not act on them.
                event.stopPropagation();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    cancel();
                }
            }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <form
                role={request.kind === 'alert' ? 'alertdialog' : 'dialog'}
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={request.message ? messageId : undefined}
                onSubmit={(event) => {
                    event.preventDefault();
                    accept();
                }}
                className="w-96 max-w-full space-y-3 rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-2xl"
            >
                <h2 id={titleId} className="text-sm font-bold text-white">{request.title}</h2>
                {request.message && <p id={messageId} className="whitespace-pre-wrap text-xs text-gray-400">{request.message}</p>}
                {request.kind === 'prompt' && (
                    <input
                        ref={inputRef}
                        aria-label={request.title}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
                    />
                )}
                <div className="flex justify-end gap-2">
                    {request.kind !== 'alert' && (
                        <button type="button" onClick={cancel} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
                    )}
                    <button
                        ref={acceptRef}
                        type="submit"
                        className={`rounded px-3 py-1.5 text-xs font-bold text-accent-ink ${request.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
                    >
                        {request.acceptLabel}
                    </button>
                </div>
            </form>
        </div>
    );
};

/** Draws the oldest unanswered app dialog. Mount once, at the root of the editor. */
export const AppDialogHost: React.FC = () => {
    const [current] = useAppDialogs();
    if (!current) return null;
    // Keyed by id so each dialog starts with its own field value and focus.
    return createPortal(<AppDialog key={current.id} request={current} />, document.body);
};
