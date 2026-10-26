import React, { useEffect, useState } from 'react';
import { AUDIO_BUSES, type AudioBus } from '../runtime/audioMixer';
import { applyBindingOverrides, DEFAULT_INPUT_MAP, describeBinding, type InputBinding } from '../runtime/input';
import { usePlayerOptions, type PlayerOptionsStore } from '../runtime/playerOptions';
import { uiActionLabelKey, useLocale, useTranslation, useUiText, type BuiltinUiKey } from '../runtime/localization';

const BUS_LABEL_KEYS: Record<AudioBus, BuiltinUiKey> = {
    master: 'ui.options.volume.master',
    music: 'ui.options.volume.music',
    sfx: 'ui.options.volume.sfx',
    ui: 'ui.options.volume.ui',
};

/** Player-facing options: look, audio buses and key rebinding. Changes save immediately. */
export const OptionsMenu: React.FC<{ store: PlayerOptionsStore; onClose: () => void }> = ({ store, onClose }) => {
    const options = usePlayerOptions(store);
    const { locale, locales, setLocale } = useLocale();
    const text = useUiText();
    const translate = useTranslation();
    const [listening, setListening] = useState<string | null>(null);
    const actions = applyBindingOverrides(DEFAULT_INPUT_MAP, options.bindings);

    // While rebinding, the next key or mouse button replaces the action's keyboard/mouse bindings;
    // gamepad bindings are kept so a pad keeps working.
    useEffect(() => {
        if (!listening) return;
        const assign = (binding: InputBinding) => {
            const action = actions.find(item => item.name === listening);
            const keep = (action?.bindings ?? []).filter(item => item.device === 'gamepad' || item.device === 'gamepadAxis');
            store.update({ bindings: { ...options.bindings, [listening]: [binding, ...keep] } });
            setListening(null);
        };
        const onKey = (event: KeyboardEvent) => {
            event.preventDefault();
            if (event.code === 'Escape') { setListening(null); return; }
            assign({ device: 'keyboard', code: event.code });
        };
        const onMouse = (event: MouseEvent) => { event.preventDefault(); assign({ device: 'mouse', button: event.button }); };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onMouse, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mousedown', onMouse, true);
        };
    }, [listening, actions, options.bindings, store]);

    return (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/85 text-white">
            <div className="w-[min(560px,92vw)] max-h-[88vh] overflow-y-auto rounded-lg bg-neutral-900 p-6 space-y-6">
                <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-bold">{text('ui.options')}</h2>
                    <button onClick={onClose} className="px-4 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm">{text('ui.options.back')}</button>
                </div>

                <section className="space-y-3">
                    <h3 className="text-xs uppercase tracking-wider text-white/50">{text('ui.options.look')}</h3>
                    <label className="flex items-center justify-between gap-4 text-sm">
                        {text('ui.options.mouseSensitivity')}
                        <input type="range" min={0.0005} max={0.01} step={0.0005} value={options.mouseSensitivity}
                            onChange={event => store.update({ mouseSensitivity: Number(event.target.value) })} className="w-48" />
                    </label>
                    <label className="flex items-center justify-between gap-4 text-sm">
                        {text('ui.options.invertY')}
                        <input type="checkbox" checked={options.invertY} onChange={event => store.update({ invertY: event.target.checked })} />
                    </label>
                </section>

                {locales.length > 1 && (
                    <section className="space-y-3">
                        <h3 className="text-xs uppercase tracking-wider text-white/50">{text('ui.options.language')}</h3>
                        <label className="flex items-center justify-between gap-4 text-sm">
                            {text('ui.options.textLanguage')}
                            <select value={locale} onChange={event => setLocale(event.target.value)} className="w-48 rounded bg-white/10 px-2 py-1">
                                {locales.map(code => <option key={code} value={code} className="bg-gray-900">{code}</option>)}
                            </select>
                        </label>
                    </section>
                )}

                <section className="space-y-3">
                    <h3 className="text-xs uppercase tracking-wider text-white/50">{text('ui.options.audio')}</h3>
                    {AUDIO_BUSES.map(bus => (
                        <label key={bus} className="flex items-center justify-between gap-4 text-sm">
                            {text(BUS_LABEL_KEYS[bus])}
                            <span className="flex items-center gap-3">
                                <input type="range" min={0} max={1} step={0.05} value={options.volumes[bus]}
                                    onChange={event => store.update({ volumes: { ...options.volumes, [bus]: Number(event.target.value) } })} className="w-48" />
                                <span className="w-10 text-right text-white/60">{Math.round(options.volumes[bus] * 100)}%</span>
                            </span>
                        </label>
                    ))}
                </section>

                <section className="space-y-2">
                    <h3 className="text-xs uppercase tracking-wider text-white/50">{text('ui.options.controls')}</h3>
                    {actions.map(action => (
                        <div key={action.name} className="flex items-center justify-between gap-4 text-sm">
                            <span>{translate(uiActionLabelKey(action.name), undefined, action.label)}</span>
                            <span className="flex items-center gap-2">
                                <span className="text-white/60">{action.bindings.map(describeBinding).join(', ')}</span>
                                <button onClick={() => setListening(action.name)}
                                    className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs min-w-24">
                                    {listening === action.name ? text('ui.options.pressKey') : text('ui.options.rebind')}
                                </button>
                            </span>
                        </div>
                    ))}
                    <button onClick={() => store.update({ bindings: {} })} className="mt-2 text-xs text-white/60 hover:text-white">{text('ui.options.resetControls')}</button>
                </section>
            </div>
        </div>
    );
};
