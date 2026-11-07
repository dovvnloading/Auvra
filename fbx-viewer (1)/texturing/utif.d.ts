// UTIF, the TIFF decoder three ships, as the texture decoder uses it (its raw samples keep their depth).

declare module 'three/examples/jsm/libs/utif.module.js' {
    /** A picture's directory: its size, its samples once decoded, and its tags by number (t258...). */
    interface UtifImage {
        width: number;
        height: number;
        data: Uint8Array;
    }
    const UTIF: {
        decode(buffer: ArrayBuffer): UtifImage[];
        decodeImage(buffer: ArrayBuffer, image: object): void;
        toRGBA8(image: object): Uint8Array;
    };
    export default UTIF;
}
