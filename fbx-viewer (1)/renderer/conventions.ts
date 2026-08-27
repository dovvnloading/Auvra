/** Fixed coordinate, depth, and color conventions for all renderer backends. */
export type Handedness = "right-handed";
export type UpAxis = "+Y";
export type ForwardAxis = "-Z";
export type DepthRange = readonly [0, 1];

export interface CoordinateConventions {
  readonly handedness: Handedness;
  readonly upAxis: UpAxis;
  readonly forwardAxis: ForwardAxis;
  readonly units: "meters";
  readonly angleUnit: "radians";
  readonly frontFace: "counter-clockwise";
  readonly depthRange: DepthRange;
}

export interface ColorConventions {
  readonly workingSpace: "linear";
  readonly colorTextureInput: "sRGB";
  readonly dataTextureInput: "linear";
  readonly uiColorInput: "sRGB";
  readonly outputTransfer: "sRGB";
  readonly toneMapping: "ACES";
  readonly toneMappingExposure: 1;
}

export interface RenderConventions {
  readonly coordinates: CoordinateConventions;
  readonly color: ColorConventions;
  readonly version: 1;
}

export const RENDER_CONVENTIONS: RenderConventions = Object.freeze({
  version: 1,
  coordinates: Object.freeze({
    handedness: "right-handed",
    upAxis: "+Y",
    forwardAxis: "-Z",
    units: "meters",
    angleUnit: "radians",
    frontFace: "counter-clockwise",
    depthRange: [0, 1] as const,
  }),
  color: Object.freeze({
    workingSpace: "linear",
    colorTextureInput: "sRGB",
    dataTextureInput: "linear",
    uiColorInput: "sRGB",
    outputTransfer: "sRGB",
    toneMapping: "ACES",
    toneMappingExposure: 1,
  }),
});

export const DEFAULT_RENDER_CONVENTIONS = RENDER_CONVENTIONS;

export function isRenderConventions(value: unknown): value is RenderConventions {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RenderConventions>;
  const coordinates = candidate.coordinates;
  const color = candidate.color;
  return candidate.version === 1 && !!coordinates && coordinates.handedness === "right-handed" && coordinates.upAxis === "+Y" && coordinates.forwardAxis === "-Z" && coordinates.units === "meters" && coordinates.angleUnit === "radians" && coordinates.frontFace === "counter-clockwise" && Array.isArray(coordinates.depthRange) && coordinates.depthRange[0] === 0 && coordinates.depthRange[1] === 1 && !!color && color.workingSpace === "linear" && color.colorTextureInput === "sRGB" && color.dataTextureInput === "linear" && color.uiColorInput === "sRGB" && color.outputTransfer === "sRGB" && color.toneMapping === "ACES" && color.toneMappingExposure === 1;
}

export function assertRenderConventions(value: unknown): asserts value is RenderConventions {
  if (!isRenderConventions(value)) throw new Error("Renderer conventions must use Auvra's fixed coordinate and color pipeline");
}
