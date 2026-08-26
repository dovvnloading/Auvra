
import React from 'react';
import { Heart } from 'lucide-react';

interface HealthWidgetProps {
    value?: number;
    max?: number;
    barColor?: string;
    backgroundColor?: string;
    showIcon?: boolean;
    showText?: boolean;
}

export const HealthWidget: React.FC<HealthWidgetProps> = ({
    value = 75,
    max = 100,
    barColor = "#dc2626", // red-600
    backgroundColor = "#1f2937", // gray-800
    showIcon = true,
    showText = true
}) => {
    const percent = Math.max(0, Math.min(100, (value / max) * 100));

    return (
        <div className="w-full h-full flex flex-col justify-center">
            <div className="flex items-center gap-2 mb-1">
                {showIcon && <Heart size={16} color={barColor} fill={barColor} className="animate-pulse" />}
                {showText && (
                    <span className="text-sm font-bold font-mono text-white">
                        {value}/{max}
                    </span>
                )}
            </div>
            <div 
                className="w-full h-3 rounded-full overflow-hidden border border-white/10"
                style={{ backgroundColor: backgroundColor }}
            >
                <div 
                    className="h-full transition-all duration-300"
                    style={{ width: `${percent}%`, backgroundColor: barColor }}
                />
            </div>
        </div>
    );
};
