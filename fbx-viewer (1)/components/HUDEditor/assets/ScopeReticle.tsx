
import React from 'react';

interface ScopeReticleProps {
    color?: string;
    opacity?: number;
    scale?: number;
    glowIntensity?: number;
}

export const ScopeReticle: React.FC<ScopeReticleProps> = ({ 
    color = "#ef4444", 
    opacity = 0.9, 
    scale = 1.0,
    glowIntensity = 2
}) => {
    return (
        <div 
            className="w-full h-full relative overflow-hidden bg-black/20"
            style={{ 
                opacity: opacity,
                transform: `scale(${scale})`,
                color: color
            }}
        >
            {/* 1. Cinematic Letterbox/Vignette - Simulates the physical housing */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_25%,rgba(0,0,0,0.6)_50%,#000_70%)] mix-blend-normal" />
                
            {/* 2. Lens Imperfections & Chromatic Tint */}
            <div className="reticle-noise absolute inset-0 opacity-[0.08] mix-blend-overlay" aria-hidden="true" />
            
            {/* 3. Reticle System */}
            <div 
                className="absolute inset-0 flex items-center justify-center p-4"
                style={{ filter: `drop-shadow(0 0 ${glowIntensity}px ${color})` }}
            >
                <svg className="w-full h-full" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet">
                    <defs>
                        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                            <feGaussianBlur stdDeviation="2" result="coloredBlur"/>
                            <feMerge>
                                <feMergeNode in="coloredBlur"/>
                                <feMergeNode in="SourceGraphic"/>
                            </feMerge>
                        </filter>
                    </defs>
                    
                    {/* --- CENTER CROSSHAIR --- */}
                    {/* Fine center dot */}
                    <circle cx="500" cy="500" r="2" fill="currentColor" filter="url(#glow)" />
                    
                    {/* Perfect Center Ring - SOLID */}
                    <circle cx="500" cy="500" r="40" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.8" />
                    
                    {/* Horizontal Line */}
                    <line x1="0" y1="500" x2="420" y2="500" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
                    <line x1="580" y1="500" x2="1000" y2="500" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
                    
                    {/* Vertical Line */}
                    <line x1="500" y1="0" x2="500" y2="420" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />
                    <line x1="500" y1="580" x2="500" y2="1000" stroke="currentColor" strokeWidth="1" strokeOpacity="0.5" />

                    {/* --- OUTER RINGS (Perfect Solid Circles) --- */}
                    {/* Inner Decorative Ring - Radius 220 */}
                    <circle 
                        cx="500" cy="500" r="220" 
                        fill="none" stroke="currentColor" strokeWidth="1" 
                        strokeOpacity="0.3"
                    />

                    {/* Outer Edge Ring - Radius 320 */}
                    <circle 
                        cx="500" cy="500" r="320" 
                        fill="none" stroke="currentColor" strokeWidth="2"
                        strokeOpacity="0.5"
                    />
                    
                    {/* Compass Tick at Top */}
                    <line x1="500" y1="170" x2="500" y2="190" stroke="currentColor" strokeWidth="2" />
                    <text x="500" y="160" fontSize="14" fill="currentColor" fontFamily="monospace" fontWeight="bold" textAnchor="middle">N</text>

                    {/* --- BRACKETS (Math perfect) --- */}
                    {/* Tight Focus Brackets */}
                    <path d="M 440,500 L 460,500" stroke="currentColor" strokeWidth="2" />
                    <path d="M 540,500 L 560,500" stroke="currentColor" strokeWidth="2" />
                    <path d="M 500,440 L 500,460" stroke="currentColor" strokeWidth="2" />
                    <path d="M 500,540 L 500,560" stroke="currentColor" strokeWidth="2" />

                    {/* Stadia Lines (Bullet Drop) */}
                    {[1, 2, 3, 4].map(i => (
                        <g key={i} opacity={0.9 - (i * 0.15)}>
                            <line 
                                x1={500 - (15 + i * 5)} 
                                y1={500 + (i * 60)} 
                                x2={500 + (15 + i * 5)} 
                                y2={500 + (i * 60)} 
                                stroke="currentColor" 
                                strokeWidth="1.5" 
                            />
                            <text 
                                x={500 + (25 + i * 5)} 
                                y={500 + (i * 60) + 4} 
                                fontSize="12" 
                                fill="currentColor" 
                                fontFamily="monospace" 
                                opacity="0.7"
                            >
                                {i * 100}
                            </text>
                        </g>
                    ))}
                </svg>
            </div>

            {/* 4. Peripheral Data HUD (In-Component) */}
            <div className="absolute inset-0 p-6 flex flex-col justify-between pointer-events-none mix-blend-screen">
                <div className="flex justify-between items-start">
                    {/* Top Left Info */}
                    <div className="flex flex-col gap-1 items-start">
                        <div className="flex items-center gap-2">
                            <span className="h-1 w-1 bg-current rounded-full animate-pulse" />
                            <span className="text-[9px] font-mono font-bold tracking-[0.2em] opacity-80">OPTICS.SYS</span>
                        </div>
                        <div className="h-[1px] w-16 bg-gradient-to-r from-current to-transparent opacity-60" />
                        <div className="flex items-baseline gap-1 mt-1">
                            <span className="text-xl font-mono font-bold tracking-tighter leading-none">4.0<span className="text-[10px]">x</span></span>
                            <span className="text-[8px] opacity-60 font-mono">ZOOM</span>
                        </div>
                    </div>

                    {/* Top Right Info */}
                    <div className="text-right flex flex-col items-end gap-1">
                            <div className="flex items-center gap-1.5">
                                <span className="text-[8px] font-mono font-bold tracking-[0.2em] opacity-60">COMP</span>
                                <div className="w-1.5 h-1.5 border border-current opacity-40 bg-current/10" />
                            </div>
                            <div className="flex gap-0.5 mt-1">
                            {[...Array(5)].map((_, i) => (
                                <span key={i} className={`w-0.5 h-2 skew-x-12 bg-current ${i < 3 ? 'opacity-100' : 'opacity-20'}`} />
                            ))}
                            </div>
                    </div>
                </div>
                
                {/* Bottom Center Range */}
                <div className="flex justify-center items-end pb-4">
                        <div className="flex flex-col items-center gap-1 opacity-80">
                            <div className="flex items-center gap-6">
                                <span className="text-[8px] font-mono tracking-wider opacity-70">RNG</span>
                                <span className="text-[8px] font-mono tracking-wider opacity-70">AUTO</span>
                            </div>
                            <div className="w-32 h-[1px] bg-current opacity-30 relative flex justify-between items-center">
                            <div className="h-1 w-[1px] bg-current" />
                            <div className="h-1 w-[1px] bg-current" />
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-[1px] bg-current opacity-40" />
                            </div>
                        </div>
                </div>
            </div>
        </div>
    );
};
