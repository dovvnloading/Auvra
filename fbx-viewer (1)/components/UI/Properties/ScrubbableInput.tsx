
import React, { useState, useRef, useEffect } from 'react';

interface ScrubbableInputProps {
  value: number;
  onChange: (val: number) => void;
  label: string;
  labelColor?: string;
  step?: number;
  labelWidth?: string;
}

export const ScrubbableInput: React.FC<ScrubbableInputProps> = ({ 
    value, 
    onChange, 
    label, 
    labelColor = "text-gray-400", 
    step = 0.1,
    labelWidth = "w-6"
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [localStr, setLocalStr] = useState(value.toString());
    const inputRef = useRef<HTMLInputElement>(null);
    
    // Dragging state
    const isDragging = useRef(false);
    const startX = useRef(0);
    const startVal = useRef(0);
    const dragValue = useRef(value);

    // Determines decimal places for consistency
    const getDecimals = () => step < 0.1 ? 2 : (step < 1 ? 1 : 0);

    // Sync prop to local string when not editing and not dragging
    useEffect(() => {
        if (!isEditing && !isDragging.current) {
             setLocalStr(Number(value).toFixed(getDecimals()));
        }
    }, [value, isEditing, step]);

    // Focus input when entering edit mode
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    useEffect(() => () => {
        // A component can unmount while a pointer is captured; never leave the
        // document cursor in the scrub state in that case.
        document.body.style.cursor = '';
    }, []);

    // -- SCRUBBING HANDLERS (Label) --
    
    const handlePointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        
        isDragging.current = true;
        startX.current = e.clientX;
        startVal.current = value;
        dragValue.current = value;
        
        document.body.style.cursor = 'ew-resize';
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!isDragging.current) return;
        
        e.preventDefault();
        const deltaX = e.clientX - startX.current;
        
        // Sensitivity
        let sensitivity = step;
        if (step >= 1) sensitivity = 0.5; // Scale down for large steps
        else sensitivity = step * 0.5; // Fine tune
        
        if (e.shiftKey) sensitivity *= 0.1;

        const rawValue = startVal.current + (deltaX * sensitivity);
        
        // Rounding
        const decimals = step < 0.1 ? 3 : (step < 1 ? 2 : 1);
        const factor = Math.pow(10, decimals);
        const rounded = Math.round(rawValue * factor) / factor;

        // CRITICAL FIX: Update local string during drag so input updates visually
        // Otherwise the useEffect is blocked by !isDragging.current
        setLocalStr(rounded.toFixed(getDecimals()));
        dragValue.current = rounded;

        onChange(rounded);
    };

    const finishDragging = (e?: React.PointerEvent) => {
        if (isDragging.current) {
            isDragging.current = false;
            document.body.style.cursor = '';
            if (e) {
                const target = e.currentTarget as Element;
                if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
            }
            
            // Final sync after drag releases to ensure precision
            setLocalStr(Number(dragValue.current).toFixed(getDecimals()));
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => finishDragging(e);
    const handlePointerCancel = (e: React.PointerEvent) => finishDragging(e);

    const roundValue = (rawValue: number) => {
        const decimals = step < 0.1 ? 3 : (step < 1 ? 2 : 1);
        const factor = Math.pow(10, decimals);
        return Math.round(rawValue * factor) / factor;
    };

    const handleScrubKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        let direction = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') direction = 1;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') direction = -1;
        if (direction === 0) return;
        e.preventDefault();
        const multiplier = e.shiftKey ? 0.1 : 1;
        const next = roundValue(value + direction * step * multiplier);
        setLocalStr(next.toFixed(getDecimals()));
        onChange(next);
    };

    // -- EDITING HANDLERS (Input) --

    const handleInputBlur = () => {
        setIsEditing(false);
        const num = parseFloat(localStr);
        if (!isNaN(num)) {
            onChange(num);
            // useEffect will handle formatting
        } else {
            setLocalStr(value.toString());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleInputBlur();
        }
        if (e.key === 'Escape') {
             setIsEditing(false);
             setLocalStr(value.toString());
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setLocalStr(e.target.value);
    };

    return (
        <div className="flex items-center bg-gray-950 border border-gray-800 rounded-md overflow-hidden h-7 transition-colors hover:border-gray-600 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 group/input">
            {/* Draggable Label */}
            <button
                className={`
                    ${labelWidth} h-full flex items-center justify-center 
                    bg-gray-900 border-r border-gray-800 
                    cursor-ew-resize hover:bg-gray-800 hover:text-white transition-colors
                    select-none px-1 appearance-none border-0
                `}
                type="button"
                aria-label={`Scrub ${label || 'value'}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onKeyDown={handleScrubKeyDown}
                title="Drag to scrub value"
            >
                <span className={`text-[10px] font-bold ${labelColor} truncate`}>{label}</span>
            </button>

            {/* Editable Value */}
            <div className="flex-1 h-full relative">
                {isEditing ? (
                    <input
                        ref={inputRef}
                        type="number"
                        step={step}
                        value={localStr}
                        onChange={handleChange}
                        onBlur={handleInputBlur}
                        onKeyDown={handleKeyDown}
                        className="w-full h-full bg-transparent text-[11px] text-white px-2 focus:outline-none font-mono"
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => setIsEditing(true)}
                        aria-label={`Edit ${label || 'value'}`}
                        className="w-full h-full flex items-center px-2 text-[11px] text-gray-300 font-mono cursor-text hover:text-white truncate bg-transparent border-0 text-left"
                        title="Click to edit"
                    >
                        {localStr}
                    </button>
                )}
            </div>
        </div>
    );
};
