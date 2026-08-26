import React, { useState, useEffect } from 'react';

export const formatKeyCode = (code: string) => {
    if (!code) return 'None';
    if (code.startsWith('Key')) return code.replace('Key', '');
    if (code.startsWith('Digit')) return code.replace('Digit', '');
    if (code === 'Space') return 'Space';
    if (code.startsWith('Arrow')) return code.replace('Arrow', '');
    return code;
};

interface KeyRecorderProps {
    value: string;
    onChange: (code: string) => void;
}

export const KeyRecorder: React.FC<KeyRecorderProps> = ({ value, onChange }) => {
    const [isListening, setIsListening] = useState(false);

    useEffect(() => {
        if (!isListening) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            onChange(e.code);
            setIsListening(false);
        };

        const handleMouseDown = (e: MouseEvent) => {
             setIsListening(false);
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('mousedown', handleMouseDown);
        
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('mousedown', handleMouseDown);
        };
    }, [isListening, onChange]);

    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                setIsListening(true);
            }}
            className={`
                h-6 px-2 min-w-[60px] rounded text-[10px] font-bold uppercase tracking-wider border transition-all flex items-center justify-center
                ${isListening 
                    ? 'bg-white text-black border-white shadow-[0_0_10px_rgba(255,255,255,0.3)]' 
                    : 'bg-gray-900 text-gray-400 border-gray-700 hover:border-gray-500 hover:text-white'
                }
            `}
            title="Click to bind key"
        >
            {isListening ? 'Press Key' : formatKeyCode(value)}
        </button>
    );
};