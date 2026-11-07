// UTIF, the TIFF decoder three ships, as the texture decoder uses it (its raw samples keep their depth).

declare module 'three/examples/jsm/libs/utif.module.js' {
    interface UtifImage {
        width: number;
        height: number;
        data: Uint8Array;
        [tag: string]: unknown;
    }
    const UTIF: {
        decode(buffer: ArrayBuffer): UtifImage[];
        decodeImage(buffer: ArrayBuffer, image: UtifImage): void;
        toRGBA8(image: UtifImage): Uint8Array;
    };
    export default UTIF;
}
