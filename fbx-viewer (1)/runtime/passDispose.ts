import { Pass } from 'postprocessing';

/**
 * Frees the material on a pass's screen when the pass goes. The library's dispose only frees what a pass holds
 * directly, and that material hangs off the screen mesh, so it would stay in the renderer's shader cache for good
 * along with everything it reads. Patched here rather than in each composer because effects keep passes of their own.
 */
export const installPassDispose = (): void => {
    const before = Pass.prototype.dispose;
    const marked = before as unknown as { auvraPass?: boolean };
    if (marked.auvraPass) return;
    const chained = function dispose(this: Pass) {
        before.call(this);
        this.fullscreenMaterial?.dispose();
    };
    (chained as unknown as { auvraPass: boolean }).auvraPass = true;
    Pass.prototype.dispose = chained;
};

installPassDispose();
