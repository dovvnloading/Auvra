
import React from 'react';
import { Html } from '@react-three/drei';

interface WorldHealthBarProps {
  current: number;
  max: number;
  visible: boolean;
  heightOffset?: number;
  scale?: number;
}

export const WorldHealthBar: React.FC<WorldHealthBarProps> = ({ 
  current, 
  max, 
  visible, 
  heightOffset = 2.0,
  scale = 1.0
}) => {
  if (!visible) return null;

  const percent = Math.max(0, Math.min(100, (current / max) * 100));
  
  // Color logic: White/Green -> Yellow -> Red
  let colorClass = "bg-white";
  if (percent < 60) colorClass = "bg-yellow-400";
  if (percent < 30) colorClass = "bg-red-500";

  return (
    <group position={[0, heightOffset, 0]}>
      <Html center distanceFactor={8} zIndexRange={[50, 0]} style={{ pointerEvents: 'none' }}>
        <div 
            className="flex flex-col items-center gap-1 opacity-90 transition-opacity duration-200"
            style={{ transform: `scale(${scale})` }}
        >
            {/* Main Bar */}
            <div className="w-20 h-1 bg-gray-900/80 border border-gray-950/50 rounded-full overflow-hidden backdrop-blur-sm">
                <div 
                    className={`h-full ${colorClass} transition-all duration-200 ease-out shadow-[0_0_4px_rgba(255,255,255,0.2)]`} 
                    style={{ width: `${percent}%` }}
                />
            </div>
            
            {/* Optional Value Text - only shows if damaged to reduce clutter */}
            {percent < 100 && (
                <span className="text-[8px] font-mono font-bold text-white drop-shadow-md bg-black/40 px-1 rounded">
                    {Math.ceil(current)}
                </span>
            )}
        </div>
      </Html>
    </group>
  );
};
