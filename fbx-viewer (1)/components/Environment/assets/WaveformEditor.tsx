
import React, { useRef, useEffect, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';

interface WaveformEditorProps {
    audioUrl: string;
    loopStart: number | undefined;
    loopEnd: number | undefined; 
    onChangeLoopStart: (seconds: number) => void;
    onChangeLoopEnd: (seconds: number) => void;
}

export const WaveformEditor: React.FC<WaveformEditorProps> = ({ 
    audioUrl, 
    loopStart,
    loopEnd, 
    onChangeLoopStart,
    onChangeLoopEnd 
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const ctxRef = useRef<AudioContext | null>(null);

    // Interaction State
    const draggingRef = useRef<'start' | 'end' | null>(null);

    // Initialize AudioContext
    useEffect(() => {
        if (!ctxRef.current) {
            ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
    }, []);

    // Load Audio Data
    useEffect(() => {
        if (!audioUrl || !ctxRef.current) return;

        let active = true;
        setIsLoading(true);
        setError(null);

        fetch(audioUrl)
            .then(res => res.arrayBuffer())
            .then(arrayBuffer => ctxRef.current!.decodeAudioData(arrayBuffer))
            .then(decodedBuffer => {
                if (active) {
                    setAudioBuffer(decodedBuffer);
                    setIsLoading(false);
                }
            })
            .catch(err => {
                console.error("Waveform decode error:", err);
                if (active) {
                    setError("Failed to decode audio");
                    setIsLoading(false);
                }
            });

        return () => { active = false; };
    }, [audioUrl]);

    // Derived values
    const duration = audioBuffer?.duration || 0;
    const effectiveLoopStart = loopStart !== undefined ? loopStart : 0;
    const effectiveLoopEnd = (loopEnd !== undefined && loopEnd > 0) ? loopEnd : duration;

    // Draw Waveform
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !audioBuffer) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const data = audioBuffer.getChannelData(0);
        const step = Math.ceil(data.length / width);
        const amp = height / 2;

        // 1. Background (Inactive container)
        ctx.fillStyle = '#111827'; // Dark gray
        ctx.fillRect(0, 0, width, height);

        // 2. Calculate Pixel Positions
        const startX = (effectiveLoopStart / duration) * width;
        const endX = (effectiveLoopEnd / duration) * width;

        // 3. Draw Active Region Background (Lighter Gray)
        ctx.fillStyle = '#1f2937'; 
        if (endX > startX) {
            ctx.fillRect(startX, 0, endX - startX, height);
        }

        // 4. Draw Inactive Dimming (Pre-Start and Post-End)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        // Pre-Start
        ctx.fillRect(0, 0, startX, height);
        // Post-End
        ctx.fillRect(endX, 0, width - endX, height);

        // 5. Draw Waveform
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#6b7280'; // Medium gray
        ctx.beginPath();

        for (let i = 0; i < width; i++) {
            let min = 1.0;
            let max = -1.0;
            
            for (let j = 0; j < step; j++) {
                const datum = data[(i * step) + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            
            ctx.moveTo(i, (1 + min) * amp);
            ctx.lineTo(i, (1 + max) * amp);
        }
        ctx.stroke();

        // 6. Draw Overlay (Second pass of dimming on top of waveform for inactive areas)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, startX, height);
        ctx.fillRect(endX, 0, width - endX, height);

        // 7. START Line (Cyan)
        ctx.strokeStyle = '#06b6d4'; 
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, height);
        ctx.stroke();

        // 8. END Line (Amber)
        ctx.strokeStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, height);
        ctx.stroke();

        // 9. Labels
        ctx.font = '10px monospace';
        
        // Start Label
        ctx.fillStyle = '#06b6d4';
        const startLabel = `${effectiveLoopStart.toFixed(2)}s`;
        const startTextX = Math.max(2, Math.min(startX + 4, width - 40));
        ctx.fillText(startLabel, startTextX, height - 6);

        // End Label
        ctx.fillStyle = '#f59e0b';
        const endLabel = `${effectiveLoopEnd.toFixed(2)}s`;
        const endWidth = ctx.measureText(endLabel).width;
        const endTextX = Math.max(2, Math.min(endX - endWidth - 4, width - endWidth));
        ctx.fillText(endLabel, endTextX, 12);

    }, [audioBuffer, effectiveLoopStart, effectiveLoopEnd, duration]);

    const handlePointerDown = (e: React.PointerEvent) => {
        if (!audioBuffer || !canvasRef.current) return;
        (e.target as Element).setPointerCapture(e.pointerId);
        
        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;
        
        const startX = (effectiveLoopStart / duration) * width;
        const endX = (effectiveLoopEnd / duration) * width;

        // Determine closest handle
        const distStart = Math.abs(x - startX);
        const distEnd = Math.abs(x - endX);

        if (distStart < distEnd && distStart < 30) {
            draggingRef.current = 'start';
        } else if (distEnd < 30) {
            draggingRef.current = 'end';
        } else {
            // Default to whatever is closer if click is vague, but prioritize closest valid region edge
            draggingRef.current = distStart < distEnd ? 'start' : 'end';
        }
        
        processDrag(e);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (e.buttons !== 1 || !draggingRef.current) return;
        processDrag(e);
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        draggingRef.current = null;
        (e.target as Element).releasePointerCapture(e.pointerId);
    };

    const processDrag = (e: React.PointerEvent) => {
        if (!audioBuffer || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const ratio = x / rect.width;
        const time = ratio * duration;

        if (draggingRef.current === 'start') {
            // Clamp start: 0 <= Start < End
            const newStart = Math.min(time, effectiveLoopEnd - 0.05);
            onChangeLoopStart(Math.max(0, newStart));
        } else if (draggingRef.current === 'end') {
            // Clamp end: Start < End <= Duration
            const newEnd = Math.max(time, effectiveLoopStart + 0.05);
            onChangeLoopEnd(Math.min(duration, newEnd));
        }
    };

    const togglePlay = () => {
        if (!audioBuffer || !ctxRef.current) return;

        if (isPlaying) {
            if (sourceRef.current) {
                sourceRef.current.stop();
                sourceRef.current = null;
            }
            setIsPlaying(false);
        } else {
            const source = ctxRef.current.createBufferSource();
            source.buffer = audioBuffer;
            source.loop = true;
            source.loopStart = effectiveLoopStart;
            source.loopEnd = effectiveLoopEnd;
            
            source.connect(ctxRef.current.destination);
            
            source.start(0, effectiveLoopStart);
            
            sourceRef.current = source;
            setIsPlaying(true);
            
            source.onended = () => {
                setIsPlaying(false);
                sourceRef.current = null;
            };
        }
    };

    useEffect(() => {
        return () => {
            if (sourceRef.current) {
                sourceRef.current.stop();
            }
        };
    }, []);

    if (error) return <div className="text-[10px] text-red-400 p-2 border border-red-900/50 bg-red-900/20 rounded">{error}</div>;

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-400">Waveform (Loop Region)</span>
                <button 
                    onClick={togglePlay}
                    disabled={isLoading || !audioBuffer}
                    className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-bold transition-colors ${isPlaying ? 'bg-amber-600 border-amber-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-300 hover:text-white'}`}
                >
                    {isLoading ? <Loader2 size={10} className="animate-spin" /> : (isPlaying ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />)}
                    {isPlaying ? 'STOP' : 'TEST LOOP'}
                </button>
            </div>
            
            <div className="relative h-20 w-full bg-black rounded border border-gray-700 overflow-hidden cursor-crosshair">
                <canvas 
                    ref={canvasRef} 
                    width={300} 
                    height={80} 
                    className="w-full h-full touch-none"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handlePointerUp}
                />
            </div>
            <div className="flex justify-between text-[9px] text-gray-500 italic">
                <span className="text-cyan-500">Drag Start</span>
                <span className="text-amber-500">Drag End</span>
            </div>
        </div>
    );
};
