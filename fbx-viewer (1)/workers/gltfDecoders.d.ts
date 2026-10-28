// The Emscripten decoders three includes for compressed glTF: CommonJS, bundled by Vite for the workers that run them.

declare module 'three/examples/jsm/libs/basis/basis_transcoder.js' {
    /** The Basis Universal transcoder's module factory. */
    const BASIS: (module: object) => Promise<unknown>;
    export default BASIS;
}

declare module 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js' {
    /** The Draco decoder's module factory (the glTF build). */
    const DracoDecoderModule: (module: object) => unknown;
    export default DracoDecoderModule;
}
