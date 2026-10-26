
import React from 'react';
import { Crosshair, Box, Type, Activity, Target, Code, MousePointerClick } from 'lucide-react';
import { ScopeReticle } from './assets/ScopeReticle';
import { HealthWidget } from './assets/HealthWidget';
import { DynamicHUDComponent } from './DynamicHUDComponent';
import { HUDComponentDefinition } from './types';
import { useTranslation, type TranslationParams } from '../../runtime/localization';

/** The literal text prop of a localizable component and the string-table key prop that can replace it. */
export interface LocalizedTextProp {
    literal: string;
    key: string;
}

const LOCALIZED_TEXT_PROPS: Readonly<Record<string, LocalizedTextProp>> = {
    Text: { literal: 'text', key: 'textKey' },
    Button: { literal: 'label', key: 'labelKey' },
};

/** The literal/key pair of a component type, or null when it takes no string key. */
export const localizedTextProp = (type: string): LocalizedTextProp | null =>
    Object.prototype.hasOwnProperty.call(LOCALIZED_TEXT_PROPS, type) ? LOCALIZED_TEXT_PROPS[type] : null;

/**
 * A string-table key wins over the authored literal text when it is set. A live binding on the
 * literal wins over the key: while playing, the HUD renderer clears the key whenever the bound
 * value resolves, so the bound value is the content. An unresolved binding keeps the key.
 */
const useLocalizedText = (literal: unknown, key: unknown, params?: TranslationParams): string => {
    const t = useTranslation();
    if (typeof key === 'string' && key.trim()) return t(key.trim(), params);
    return typeof literal === 'string' || typeof literal === 'number' || typeof literal === 'boolean' ? String(literal) : '';
};

// Generic Components
const TextBlock: React.FC<any> = ({ text, textKey, textParams, color, fontSize, fontWeight, fontFamily, textAlign }) => {
    const content = useLocalizedText(text, textKey, textParams);
    return (
        <div style={{ color, fontSize: `${fontSize}px`, fontWeight, fontFamily, textAlign, width: '100%', height: '100%' }}>
            {content}
        </div>
    );
};

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

export const BUTTON_VARIANTS = ['primary', 'secondary', 'outline', 'ghost'] as const;
export type ButtonVariant = typeof BUTTON_VARIANTS[number];

const BUTTON_VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
    primary: { background: 'linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)', color: '#ffffff', border: '1px solid rgba(147, 197, 253, 0.6)', boxShadow: '0 6px 18px rgba(29, 78, 216, 0.35)' },
    secondary: { backgroundColor: 'rgba(17, 24, 39, 0.85)', color: '#e5e7eb', border: '1px solid rgba(255, 255, 255, 0.18)' },
    outline: { backgroundColor: 'transparent', color: '#ffffff', border: '2px solid rgba(255, 255, 255, 0.85)' },
    ghost: { backgroundColor: 'transparent', color: '#d1d5db', border: '1px solid transparent' },
};

/**
 * A button-looking box. It is deliberately not a <button>: the player wraps any element
 * with a menu `action` in its own focusable control, so this only draws the face.
 */
const ButtonBlock: React.FC<any> = ({ label, labelKey, variant, fontSize }) => {
    const text = useLocalizedText(label, labelKey);
    const known: ButtonVariant = (BUTTON_VARIANTS as readonly unknown[]).includes(variant) ? variant : 'primary';
    const face = BUTTON_VARIANT_STYLES[known];
    return (
        <div
            data-hud-button={known}
            style={{
                width: '100%', height: '100%', boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 16px', borderRadius: 10, userSelect: 'none',
                fontSize: `${Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 24}px`,
                fontWeight: 700, letterSpacing: '0.06em',
                ...face,
            }}
        >
            <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {text}
            </span>
        </div>
    );
};

// Registry
export const COMPONENT_REGISTRY: Record<string, React.FC<any>> = {
    'Scope': ScopeReticle,
    'HealthBar': HealthWidget,
    'Crosshair': BasicCrosshair,
    'Text': TextBlock,
    'Container': ContainerBlock,
    'Button': ButtonBlock,
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
        defaultSize: { width: 200, height: 200 },
        // Generated code reads bound values from its props, e.g. props.value.
        bindableProps: ['value']
    },
    {
        type: 'Scope',
        label: 'Sniper Scope',
        icon: <Target size={14} />,
        defaultProps: { color: '#ef4444', opacity: 0.9, scale: 1.0, glowIntensity: 2 },
        defaultSize: { width: 400, height: 400 },
        bindableProps: ['opacity', 'scale']
    },
    {
        type: 'HealthBar',
        label: 'Health Widget',
        icon: <Activity size={14} />,
        defaultProps: { value: 85, max: 100, barColor: '#dc2626', backgroundColor: '#1f2937', showIcon: true, showText: true },
        defaultSize: { width: 250, height: 60 },
        bindableProps: ['value', 'max']
    },
    {
        type: 'Crosshair',
        label: 'Basic Crosshair',
        icon: <Crosshair size={14} />,
        defaultProps: { color: '#ffffff', size: 20, thickness: 2, gap: 4 },
        defaultSize: { width: 64, height: 64 },
        bindableProps: ['color']
    },
    {
        type: 'Text',
        label: 'Text Block',
        icon: <Type size={14} />,
        defaultProps: { text: 'HUD ELEMENT', textKey: '', color: '#ffffff', fontSize: 16, fontWeight: 'bold', fontFamily: 'monospace', textAlign: 'left' },
        defaultSize: { width: 200, height: 40 },
        propOptions: { textAlign: ['left', 'center', 'right'] },
        bindableProps: ['text', 'color']
    },
    {
        type: 'Button',
        label: 'Button',
        icon: <MousePointerClick size={14} />,
        // `action` is edited with the Action field every element has, not as a free-text prop.
        defaultProps: { label: 'Button', labelKey: '', action: '', variant: 'primary', fontSize: 24 },
        defaultSize: { width: 320, height: 64 },
        propOptions: { variant: BUTTON_VARIANTS },
        bindableProps: ['label']
    },
    {
        type: 'Container',
        label: 'Container / Panel',
        icon: <Box size={14} />,
        defaultProps: { backgroundColor: 'rgba(0,0,0,0.5)', borderColor: '#ffffff', borderWidth: 1, borderRadius: 8 },
        defaultSize: { width: 300, height: 200 },
        bindableProps: ['backgroundColor', 'borderColor']
    }
];
