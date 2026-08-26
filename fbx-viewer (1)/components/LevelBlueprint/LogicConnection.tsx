
import React from 'react';

interface LogicConnectionProps {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color?: string;
    thickness?: number;
    isTemporary?: boolean; 
}

export const LogicConnection: React.FC<LogicConnectionProps> = ({
    x1,
    y1,
    x2,
    y2,
    color = '#ffffff',
    thickness = 2,
    isTemporary = false
}) => {
    // Calculate smooth bezier path (Unreal Engine Style)
    // We add horizontal tangents so lines exit horizontally before curving
    const dist = Math.abs(x2 - x1);
    const controlDist = Math.max(dist * 0.5, 50); // Minimum 50px tangent

    const cp1x = x1 + controlDist;
    const cp1y = y1;
    const cp2x = x2 - controlDist;
    const cp2y = y2;

    const pathData = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;

    return (
        <g className="pointer-events-none">
            {/* Halo / Shadow for readability */}
            <path 
                d={pathData} 
                stroke="#000000" 
                strokeWidth={thickness + 4} 
                strokeOpacity={0.6}
                fill="none" 
                strokeLinecap="round"
            />
            {/* Core Line */}
            <path 
                d={pathData} 
                stroke={color} 
                strokeWidth={thickness} 
                fill="none" 
                strokeLinecap="round"
                strokeDasharray={isTemporary ? "4,4" : undefined}
                className={isTemporary ? "opacity-80" : "transition-colors duration-200"}
            />
            {/* End Cap Bulb (Optional, UE style usually just line, but this helps see connection points) */}
            {!isTemporary && (
                <>
                    <circle cx={x1} cy={y1} r={thickness} fill={color} />
                    <circle cx={x2} cy={y2} r={thickness} fill={color} />
                </>
            )}
        </g>
    );
};
