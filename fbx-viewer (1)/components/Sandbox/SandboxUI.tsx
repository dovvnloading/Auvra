
import React, { useCallback, useState } from 'react';
import { Gamepad2, User, Skull, Play, Square, MousePointer2, HeartPulse, AlertCircle, CheckCircle2, Keyboard, RotateCcw, AlertTriangle, XCircle, Zap, ZapOff } from 'lucide-react';
import { Blueprint, LoadedModelData } from '../../types';
import { ScopeReticle } from '../HUDEditor/assets/ScopeReticle';

interface SandboxUIProps {
    isPlaying: boolean;
    isGameOver?: boolean;
    onStart: () => void;
    onStop: () => void;
    playerBlueprint: Blueprint;
    enemyBlueprint: Blueprint;
    playerModel: LoadedModelData | undefined;
    enemyModel: LoadedModelData | undefined;
    playerStats?: { health: number; maxHealth: number; stamina: number };
    isAiming?: boolean;
    highQuality?: boolean;
    onToggleQuality?: () => void;
}

const StatusRow: React.FC<{ label: string; value: string; isReady: boolean; icon: React.ReactNode }> = ({ label, value, isReady, icon }) => (
    <div className="flex items-center justify-between p-2 bg-gray-950 border border-gray-800 rounded group hover:border-gray-700 transition-colors">
        <div className="flex items-center gap-3">
            <div className={`p-1.5 rounded bg-gray-900 border border-gray-800 ${isReady ? 'text-gray-400' : 'text-red-500'}`}>
                {icon}
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] uppercase font-bold text-gray-500 tracking-wider leading-none mb-0.5">{label}</span>
                <span className={`text-xs font-medium truncate max-w-[120px] ${isReady ? 'text-gray-200' : 'text-red-400'}`}>
                    {value || 'Missing'}
                </span>
            </div>
        </div>
        <div className="pl-2">
            {isReady ? (
                <CheckCircle2 size={14} className="text-green-500/80" />
            ) : (
                <AlertCircle size={14} className="text-red-500/80" />
            )}
        </div>
    </div>
);

export const SandboxUI: React.FC<SandboxUIProps> = ({
    isPlaying,
    isGameOver = false,
    onStart,
    onStop,
    playerBlueprint,
    enemyBlueprint,
    playerModel,
    enemyModel,
    playerStats,
    isAiming,
    highQuality = true,
    onToggleQuality
}) => {
    
    const handleStart = useCallback(() => {
        onStart();
        setTimeout(() => {
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.requestPointerLock();
        }, 100);
    }, [onStart]);

    // --- GAME OVER SCREEN ---
    if (isGameOver) {
        return (
            <div className="absolute inset-0 z-[100] bg-black/90 backdrop-blur-sm flex flex-col items-center justify-center animate-in fade-in duration-500 pointer-events-auto cursor-default">
                
                <div className="flex flex-col items-center text-center space-y-2 mb-10">
                    <div className="text-red-600 animate-pulse mb-2">
                        <AlertTriangle size={48} />
                    </div>
                    <h1 className="text-6xl font-black text-white tracking-[0.2em] drop-shadow-[0_0_25px_rgba(220,38,38,0.6)] font-mono">
                        SIGNAL LOST
                    </h1>
                    <div className="h-px w-64 bg-red-900/50 mt-4 mb-4"></div>
                    <p className="text-xs text-red-400 font-mono tracking-widest uppercase">
                        Simulation Terminated • Fatal Error
                    </p>
                </div>

                <div className="flex gap-6">
                    <button 
                        onClick={handleStart}
                        className="group relative px-8 py-3 bg-white text-black font-bold text-sm uppercase tracking-widest hover:bg-gray-200 transition-all clip-path-slant"
                    >
                        <span className="flex items-center gap-2">
                            <RotateCcw size={16} /> Reboot System
                        </span>
                        <div className="absolute inset-0 border-2 border-white group-hover:scale-105 transition-transform" />
                    </button>

                    <button 
                        onClick={onStop}
                        className="group px-8 py-3 bg-transparent text-gray-500 hover:text-red-500 font-bold text-sm uppercase tracking-widest border border-gray-800 hover:border-red-900 transition-all"
                    >
                        <span className="flex items-center gap-2">
                            <XCircle size={16} /> Abort
                        </span>
                    </button>
                </div>

                {/* Scanlines Effect */}
                <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-[-1] background-size-[100%_2px,3px_100%]" />
            </div>
        );
    }

    // --- SCOPE OVERLAY (Visible when aiming) ---
    if (isPlaying && isAiming) {
        return (
            <div className="absolute inset-0 pointer-events-none z-50 overflow-hidden">
                <ScopeReticle color="#ef4444" opacity={1} scale={1} glowIntensity={4} />
            </div>
        );
    }

    // --- LOBBY SCREEN ---
    if (!isPlaying) {
        return (
            <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="w-[500px] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    
                    {/* Header */}
                    <div className="h-10 bg-gray-950 border-b border-gray-800 flex items-center justify-between px-4 shrink-0">
                        <div className="flex items-center gap-2 text-gray-200 font-bold text-xs tracking-wide">
                            <Gamepad2 size={14} className="text-blue-500" />
                            <span>SIMULATION CONFIG</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span>
                            <span className="text-[9px] font-mono text-gray-500 uppercase">Standby</span>
                        </div>
                    </div>

                    {/* Content Body */}
                    <div className="p-6 space-y-6">
                        
                        {/* Configuration Grid */}
                        <div className="grid grid-cols-2 gap-4">
                            {/* Player Config */}
                            <div className="space-y-2">
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                    <User size={10} /> Active Player
                                </div>
                                <div className="space-y-1">
                                    <StatusRow 
                                        label="Blueprint" 
                                        value={playerBlueprint.name} 
                                        isReady={true} 
                                        icon={<User size={12} />} 
                                    />
                                    <StatusRow 
                                        label="Target Mesh" 
                                        value={playerModel?.name || 'None'} 
                                        isReady={!!playerModel} 
                                        icon={<MousePointer2 size={12} />} 
                                    />
                                </div>
                            </div>

                            {/* Enemy Config */}
                            <div className="space-y-2">
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                    <Skull size={10} /> Opponent
                                </div>
                                <div className="space-y-1">
                                    <StatusRow 
                                        label="AI Controller" 
                                        value={enemyBlueprint.name} 
                                        isReady={true} 
                                        icon={<Skull size={12} />} 
                                    />
                                    <StatusRow 
                                        label="Target Mesh" 
                                        value={enemyModel?.name || 'None'} 
                                        isReady={!!enemyModel} 
                                        icon={<MousePointer2 size={12} />} 
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="h-px bg-gray-800 w-full" />

                        {/* Controls Reference & Quality Toggle */}
                        <div className="flex gap-4">
                            <div className="flex-1 bg-gray-950/50 rounded border border-gray-800/50 p-3">
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <Keyboard size={10} /> Input Map
                                </div>
                                <div className="grid grid-cols-2 gap-y-2 gap-x-4">
                                    <div className="flex items-center justify-between text-[10px] group"><span className="text-gray-500">Move</span><span className="font-mono text-gray-300">WASD</span></div>
                                    <div className="flex items-center justify-between text-[10px] group"><span className="text-gray-500">Fire</span><span className="font-mono text-gray-300">Mouse 1</span></div>
                                    <div className="flex items-center justify-between text-[10px] group"><span className="text-gray-500">Scope</span><span className="font-mono text-gray-300">F</span></div>
                                    <div className="flex items-center justify-between text-[10px] group"><span className="text-gray-500">Jump</span><span className="font-mono text-gray-300">Space</span></div>
                                </div>
                            </div>

                            {onToggleQuality && (
                                <button 
                                    onClick={onToggleQuality}
                                    className={`w-24 flex flex-col items-center justify-center gap-2 rounded border transition-all ${highQuality ? 'bg-blue-900/20 border-blue-500/50 text-blue-400' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'}`}
                                >
                                    {highQuality ? <Zap size={20} /> : <ZapOff size={20} />}
                                    <div className="text-[9px] font-bold uppercase">{highQuality ? 'HQ Rendering' : 'Low Perf'}</div>
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="p-4 bg-gray-950 border-t border-gray-800">
                        <button 
                            onClick={handleStart}
                            disabled={!playerModel || !enemyModel}
                            className={`
                                w-full flex items-center justify-center gap-2 py-2.5 rounded font-bold text-xs uppercase tracking-wide transition-all
                                ${(!playerModel || !enemyModel) 
                                    ? 'bg-gray-800 text-gray-500 cursor-not-allowed border border-gray-700' 
                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg hover:shadow-blue-500/20 border border-blue-500'
                                }
                            `}
                        >
                            <Play size={14} fill="currentColor" />
                            Initialize Session
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const { health = 100, maxHealth = 100, stamina = 100 } = playerStats || {};
    const healthPercent = Math.max(0, Math.min(100, (health / maxHealth) * 100));
    const staminaPercent = Math.max(0, Math.min(100, stamina));

    // --- GAME HUD ---
    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            
            {/* Center Crosshair (Standard - Hidden when Scoped) */}
            {!isAiming && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none opacity-80">
                    <div className="w-0.5 h-0.5 bg-white rounded-full shadow-[0_0_4px_rgba(255,255,255,0.8)] z-10" />
                    <div className="absolute w-4 h-4 border border-white/30 rounded-full" />
                </div>
            )}

            {/* Player HUD (Top Left) */}
            <div className="absolute top-6 left-6 animate-in slide-in-from-left-10 fade-in duration-500">
                <div className="flex flex-col gap-1 w-56">
                    <div className="flex flex-col gap-1">
                        <div className="flex justify-between items-end px-0.5">
                            <span className="text-[9px] font-bold text-gray-400 tracking-wider flex items-center gap-1 uppercase">
                                <HeartPulse size={10} className="text-red-500" /> HP
                            </span>
                            <span className="text-[10px] font-mono font-bold text-gray-300">
                                {Math.ceil(health)} <span className="text-gray-600">/</span> {maxHealth}
                            </span>
                        </div>
                        <div className="h-2 bg-gray-900/90 border border-gray-700 rounded-sm overflow-hidden relative">
                            <div 
                                className="h-full bg-red-600 transition-all duration-300 ease-out"
                                style={{ width: `${healthPercent}%` }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1 mt-1">
                        <div className="h-1 bg-gray-900/90 border border-gray-700 rounded-sm overflow-hidden relative w-3/4">
                            <div 
                                className="h-full bg-blue-500 transition-all duration-100 ease-linear"
                                style={{ width: `${staminaPercent}%` }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Controls */}
            <div className="absolute bottom-6 right-6 z-50 pointer-events-auto">
                <button 
                    onClick={onStop}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-900/90 hover:bg-gray-800 text-red-400 hover:text-red-300 font-bold text-[10px] uppercase tracking-wider rounded border border-gray-700 shadow-xl transition-all backdrop-blur-sm"
                >
                    <Square size={10} fill="currentColor" /> Stop Simulation
                </button>
            </div>
        </div>
    );
};
