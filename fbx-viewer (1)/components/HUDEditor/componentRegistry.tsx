
import React from 'react';
import { Crosshair, Box, Type, Activity, Target, Code } from 'lucide-react';
import { ScopeReticle } from './assets/ScopeReticle';
import { HealthWidget } from './assets/HealthWidget';
import { DynamicHUDComponent } from './DynamicHUDComponent';
import { HUDComponentDefinition } from './types';

// Generic Components
const TextBlock: React.FC<any> = ({ text, color, fontSize, fontWeight, fontFamily }) => (
    <div style={{ color, fontSize: `${fontSize}px`, fontWeight, fontFamily, width: '100%', height: '100%' }}>
        {text}
    </div>
);

const ContainerBlock: React.FC<any> = ({ backgroundColor, borderColor, borderWidth, borderRadius }) => (
    <div style={{ 
        width: '100%', height: '100%', 
        backgroundColor, borderColor, borderWidth: `${borderWidth}px`, borderRadius: `${borderRadius}px`, 
        borderStyle: 'solid' 
    }} />
);

const BasicCrosshair: React.FC<any> = ({ color, size, thickness, gap }) => (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', width: `${size}px`, height: `${thickness}px`, backgroundColor: color }}></div>
        <div style={{ position: 'absolute', height: `${size}px`, width: `${thickness}px`, backgroundColor: color }}></div>
        <div style={{ position: 'absolute', width: `${gap}px`, height: `${gap}px`, backgroundColor: 'transparent', zIndex: 1 }}></div>
    </div>
);

// Registry
export const COMPONENT_REGISTRY: Record<string, React.FC<any>> = {
    'Scope': ScopeReticle,
    'HealthBar': HealthWidget,
    'Crosshair': BasicCrosshair,
    'Text': TextBlock,
    'Container': ContainerBlock,
    'Custom': DynamicHUDComponent // Added Dynamic Component
};

export const AVAILABLE_COMPONENTS: HUDComponentDefinition[] = [
    {
        type: 'Custom',
        label: 'Custom Code',
        icon: <Code size={14} />,
        defaultProps: { 
            code: `// Write React code here\nreturn (\n  <div className="w-full h-full bg-blue-500/20 border border-blue-400 flex items-center justify-center text-blue-200 font-bold">\n    CUSTOM WIDGET\n  </div>\n);` 
        },
        defaultSize: { width: 200, height: 200 }
    },
    {
        type: 'Scope',
        label: 'Sniper Scope',
        icon: <Target size={14} />,
        defaultProps: { color: '#ef4444', opacity: 0.9, scale: 1.0, glowIntensity: 2 },
        defaultSize: { width: 400, height: 400 }
    },
    {
        type: 'HealthBar',
        label: 'Health Widget',
        icon: <Activity size={14} />,
        defaultProps: { value: 85, max: 100, barColor: '#dc2626', backgroundColor: '#1f2937', showIcon: true, showText: true },
        defaultSize: { width: 250, height: 60 }
    },
    {
        type: 'Crosshair',
        label: 'Basic Crosshair',
        icon: <Crosshair size={14} />,
        defaultProps: { color: '#ffffff', size: 20, thickness: 2, gap: 4 },
        defaultSize: { width: 64, height: 64 }
    },
    {
        type: 'Text',
        label: 'Text Block',
        icon: <Type size={14} />,
        defaultProps: { text: 'HUD ELEMENT', color: '#ffffff', fontSize: 16, fontWeight: 'bold', fontFamily: 'monospace' },
        defaultSize: { width: 200, height: 40 }
    },
    {
        type: 'Container',
        label: 'Container / Panel',
        icon: <Box size={14} />,
        defaultProps: { backgroundColor: 'rgba(0,0,0,0.5)', borderColor: '#ffffff', borderWidth: 1, borderRadius: 8 },
        defaultSize: { width: 300, height: 200 }
    }
];
