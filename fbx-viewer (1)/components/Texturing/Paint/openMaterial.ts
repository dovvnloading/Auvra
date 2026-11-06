/**
 * Asking for a material asset to be opened in the Materials tab (its texture graph editor), from another
 * tab: the request is kept until the Materials tab takes it, and announced with OPEN_MATERIAL_EVENT so
 * the editor can switch to that tab.
 */

export const OPEN_MATERIAL_EVENT = 'auvra:open-material';

let pending: string | null = null;

/** Asks for `id` to be opened in the Materials tab. */
export const requestOpenMaterial = (id: string): void => {
    pending = id;
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_MATERIAL_EVENT, { detail: { id } }));
};

/** The asset asked for, once: the Materials tab calls this when it opens (and on the event). */
export const takeOpenMaterialRequest = (): string | null => {
    const id = pending;
    pending = null;
    return id;
};
