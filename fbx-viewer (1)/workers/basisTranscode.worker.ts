/// <reference lib="webworker" />

import BASIS from 'three/examples/jsm/libs/basis/basis_transcoder.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/**
 * Transcodes KTX2 (Basis) textures for utils/gltfDecoders.ts. It runs three's own transcoding
 * worker, which reads the transcoder and three's format tables as globals: three normally pastes
 * them into a blob: worker, which the editor's CSP does not allow.
 */
const three = KTX2Loader as unknown as {
    EngineFormat: object;
    TranscoderFormat: object;
    BasisFormat: object;
    BasisWorker: () => void;
};
Object.assign(globalThis, {
    BASIS,
    _EngineFormat: three.EngineFormat,
    _TranscoderFormat: three.TranscoderFormat,
    _BasisFormat: three.BasisFormat,
});
three.BasisWorker();
