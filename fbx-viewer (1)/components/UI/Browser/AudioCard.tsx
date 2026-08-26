
import React, { useRef, useState } from 'react';
import { Music, Trash2, Play, Pause } from 'lucide-react';
import { AudioData } from '../../../types';

interface AudioCardProps {
    audio: AudioData;
    onDelete: () => void;
}

export const AudioCard: React.FC<AudioCardProps> = ({ audio, onDelete }) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);

    const togglePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!audioRef.current) {
            audioRef.current = new Audio(audio.url);
            audioRef.current.onended = () => setIsPlaying(false);
        }

        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    return (
        <div className="group relative flex flex-col gap-1 cursor-pointer">
            <div className="aspect-square bg-gray-800 rounded-md border border-gray-700 overflow-hidden group-hover:border-white transition-all shadow-sm relative flex items-center justify-center">
                
                {/* Audio Waveform Viz (Placeholder) */}
                <div className="w-full h-full flex items-center justify-center opacity-30">
                    <Music size={32} />
                </div>

                {/* Type Badge */}
                <div className="absolute top-1 right-1 p-1 bg-gray-900/80 backdrop-blur rounded text-gray-400">
                    <Music size={10} />
                </div>

                {/* Duration Badge */}
                <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 backdrop-blur rounded text-[8px] text-gray-300 font-mono">
                    {audio.duration ? `${audio.duration.toFixed(1)}s` : '...'}
                </div>

                {/* Actions Overlay */}
                <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                    <button 
                        onClick={togglePlay}
                        className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-full transition-colors"
                        title={isPlaying ? "Pause" : "Play Preview"}
                    >
                        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="p-2 bg-red-600 hover:bg-red-500 text-white rounded-full transition-colors"
                        title="Delete Audio"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>
            <span className="text-[11px] truncate px-0.5 text-center text-gray-400 group-hover:text-white">
                {audio.name}
            </span>
        </div>
    );
};
