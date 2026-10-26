import React, { useEffect, useRef, useState } from 'react';

export type InlineNameCommitSource = 'enter' | 'blur';

interface InlineNameInputProps {
    initialValue?: string;
    /** Fixed text shown after the input, e.g. a file extension that renames keep. */
    suffix?: string;
    placeholder?: string;
    ariaLabel: string;
    error: string | null;
    /** Returns true once the value is accepted (or the edit was closed), so a later blur is ignored. */
    onCommit: (value: string, source: InlineNameCommitSource) => boolean;
    onCancel: () => void;
    className?: string;
}

/** Single-line name editor: Enter commits, Escape cancels, blur commits through the parent's validation. */
export const InlineNameInput: React.FC<InlineNameInputProps> = ({
    initialValue = '',
    suffix,
    placeholder,
    ariaLabel,
    error,
    onCommit,
    onCancel,
    className = '',
}) => {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);
    const settledRef = useRef(false);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const settle = (action: () => boolean) => {
        if (settledRef.current) return;
        settledRef.current = action();
    };

    return (
        <div className={`flex flex-col gap-0.5 min-w-0 ${className}`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <div className={`flex items-center min-w-0 rounded border bg-gray-950 ${error ? 'border-red-500' : 'border-blue-500'}`}>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    placeholder={placeholder}
                    aria-label={ariaLabel}
                    aria-invalid={Boolean(error)}
                    spellCheck={false}
                    draggable={false}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                        // Keep editor hotkeys (delete, gizmo keys, undo) out of the text field.
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            settle(() => onCommit(value, 'enter'));
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            settledRef.current = true;
                            onCancel();
                        }
                    }}
                    onBlur={() => settle(() => onCommit(value, 'blur'))}
                    onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    className="flex-1 min-w-0 bg-transparent px-1 py-0.5 text-[11px] text-white focus:outline-none"
                />
                {suffix && <span className="pr-1 text-[10px] text-gray-500 shrink-0">{suffix}</span>}
            </div>
            {error && <span role="alert" className="text-[9px] leading-tight text-red-400 break-words">{error}</span>}
        </div>
    );
};
