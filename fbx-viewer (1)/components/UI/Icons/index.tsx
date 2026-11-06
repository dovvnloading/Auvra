import React from 'react';
import { GLYPHS, type Drawing, type GlyphName } from './glyphs';

/**
 * Auvra's icons, drawn by hand on a pixel grid (see glyphs.ts).
 *
 * The editor shows most icons at 10 to 14 px on a screen where one CSS pixel is one device pixel, so a drawing that is
 * simply scaled lands its one-pixel lines between pixels and they smear into two grey ones. Instead, each size picks a
 * framing that keeps every line on a whole pixel:
 * - 9 to 11 px uses the small 9 px drawing where an icon has one;
 * - 11 to 15 px shows the 11 px drawing at its own size, centred (half a pixel right and down when the box is even);
 * - 22 to 26, 33 to 37 and 44 to 48 px show it at two, three and four times;
 * - anything else, and an icon that spins, scales the drawing smoothly, centred exactly.
 *
 * Icons take the text colour. The faint fill in the body of things is that colour at the strength set by the CSS
 * variable --icon-tone (0.22 unless a parent sets it); giving an icon a `fill` makes that body solid instead.
 * Every icon can be seen at /icons.html on the development server.
 */

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'ref' | 'name'> {
  /** The box's width and height in CSS pixels. */
  size?: number | string;
  color?: string;
  /** Line weight on the common 24-to-the-box scale: 2, the default, is one pixel at 12 px. */
  strokeWidth?: number | string;
  /** Read `strokeWidth` as CSS pixels whatever the size. */
  absoluteStrokeWidth?: boolean;
}

export type IconComponent = React.ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>;

const CENTRE = 6;
const MAIN_SPAN = 11;
const SMALL_SPAN = 9;
const TONE: React.CSSProperties = { fillOpacity: 'var(--icon-tone, 0.22)' };

interface Frame {
  viewBox: string;
  /** CSS pixels per drawing pixel. */
  scale: number;
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

const frameOf = (origin: number, extent: number, scale: number): Frame => ({
  viewBox: `${round(origin)} ${round(origin)} ${round(extent)} ${round(extent)}`,
  scale,
});

/** The drawing at `scale` whole pixels per pixel, any spare pixel before it. */
const pixelFrame = (size: number, span: number, scale: number): Frame => {
  const lead = Math.ceil((size - span * scale) / 2);
  return frameOf(CENTRE - span / 2 - lead / scale, size / scale, scale);
};

/** The drawing filling `ratio` of the box, exactly centred. */
const smoothFrame = (size: number, span: number, ratio: number): Frame => {
  const extent = span / ratio;
  return frameOf(CENTRE - extent / 2, extent, size / extent);
};

const choose = (name: GlyphName, size: number, spinning: boolean): { drawing: Drawing; frame: Frame } => {
  const glyph: { m: Drawing; s?: Drawing } = GLYPHS[name];
  if (!spinning && Number.isFinite(size) && size > 0) {
    if (glyph.s && size >= 9 && size <= 11) return { drawing: glyph.s, frame: pixelFrame(size, SMALL_SPAN, 1) };
    const scale = Math.round(size / 12);
    if (scale >= 1 && size >= MAIN_SPAN * scale && size - MAIN_SPAN * scale <= 4) {
      return { drawing: glyph.m, frame: pixelFrame(size, MAIN_SPAN, scale) };
    }
  }
  const box = Number.isFinite(size) && size > 0 ? size : 24;
  if (glyph.s && box < 11) return { drawing: glyph.s, frame: smoothFrame(box, SMALL_SPAN, 0.9) };
  return { drawing: glyph.m, frame: smoothFrame(box, MAIN_SPAN, 5 / 6) };
};

type Layer = { kind: 'line' | 'tone' | 'solid'; d: string };
const parsed = new WeakMap<Drawing, Layer[]>();
const layersOf = (drawing: Drawing): Layer[] => {
  let layers = parsed.get(drawing);
  if (!layers) {
    layers = drawing.map((source): Layer => (source[0] === '~'
      ? { kind: 'tone', d: source.slice(1) }
      : source[0] === '#' ? { kind: 'solid', d: source.slice(1) } : { kind: 'line', d: source }));
    parsed.set(drawing, layers);
  }
  return layers;
};

/** Any icon by name: for lists of icons and catalogues. Elsewhere import the named icon. */
export const Icon = React.forwardRef<SVGSVGElement, IconProps & { name: GlyphName }>(function Icon(
  { name, size = 24, color, strokeWidth = 2, absoluteStrokeWidth = false, fill, className, style, children, ...rest },
  ref,
) {
  const spinning = typeof className === 'string' && className.includes('animate-spin');
  const { drawing, frame } = choose(name, Number(size), spinning);
  const ink = color ?? 'currentColor';
  const weight = Number(strokeWidth);
  const lineWidth = absoluteStrokeWidth ? weight / frame.scale : weight / 2;
  const filled = fill !== undefined && fill !== 'none' ? fill : undefined;
  const labelled = rest['aria-label'] !== undefined || rest['aria-labelledby'] !== undefined;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={frame.viewBox}
      fill="none"
      stroke={ink}
      strokeWidth={round(lineWidth)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      data-icon={name}
      className={className}
      style={{ overflow: 'visible', ...style }}
      {...rest}
    >
      {layersOf(drawing).map((layer, index) => (layer.kind === 'line'
        ? <path key={index} d={layer.d} />
        : <path
            key={index}
            d={layer.d}
            stroke="none"
            fill={layer.kind === 'tone' ? filled ?? ink : ink}
            style={layer.kind === 'tone' && !filled ? TONE : undefined}
          />))}
      {children}
    </svg>
  );
});

const named = (name: GlyphName, displayName: string): IconComponent => {
  const NamedIcon = React.forwardRef<SVGSVGElement, IconProps>((props, ref) => <Icon ref={ref} name={name} {...props} />);
  NamedIcon.displayName = displayName;
  return NamedIcon;
};

export { GLYPH_NAMES, type GlyphName } from './glyphs';

export const PlusIcon = named('plus', 'PlusIcon');
export const MinusIcon = named('minus', 'MinusIcon');
export const CrossIcon = named('cross', 'CrossIcon');
export const CheckIcon = named('check', 'CheckIcon');
export const DivideIcon = named('divide', 'DivideIcon');
export const EqualIcon = named('equal', 'EqualIcon');
export const HashIcon = named('hash', 'HashIcon');
export const SigmaIcon = named('sigma', 'SigmaIcon');
export const VariableIcon = named('variable', 'VariableIcon');
export const CodeIcon = named('code', 'CodeIcon');
export const TextIcon = named('text', 'TextIcon');
export const ChevronDownIcon = named('chevronDown', 'ChevronDownIcon');
export const ChevronUpIcon = named('chevronUp', 'ChevronUpIcon');
export const ChevronLeftIcon = named('chevronLeft', 'ChevronLeftIcon');
export const ChevronRightIcon = named('chevronRight', 'ChevronRightIcon');
export const ChevronsLeftRightIcon = named('chevronsLeftRight', 'ChevronsLeftRightIcon');
export const ArrowUpIcon = named('arrowUp', 'ArrowUpIcon');
export const ArrowDownIcon = named('arrowDown', 'ArrowDownIcon');
export const ArrowLeftIcon = named('arrowLeft', 'ArrowLeftIcon');
export const ArrowRightIcon = named('arrowRight', 'ArrowRightIcon');
export const ArrowsLeftRightIcon = named('arrowsLeftRight', 'ArrowsLeftRightIcon');
export const CornerDownRightIcon = named('cornerDownRight', 'CornerDownRightIcon');
export const CornerLeftUpIcon = named('cornerLeftUp', 'CornerLeftUpIcon');
export const RangeStartIcon = named('rangeStart', 'RangeStartIcon');
export const RangeEndIcon = named('rangeEnd', 'RangeEndIcon');
export const UndoIcon = named('undo', 'UndoIcon');
export const RedoIcon = named('redo', 'RedoIcon');
export const ResetIcon = named('reset', 'ResetIcon');
export const RotateIcon = named('rotate', 'RotateIcon');
export const RefreshIcon = named('refresh', 'RefreshIcon');
export const LoopIcon = named('loop', 'LoopIcon');
export const LoopOnceIcon = named('loopOnce', 'LoopOnceIcon');
export const MoveIcon = named('move', 'MoveIcon');
export const ExpandIcon = named('expand', 'ExpandIcon');
export const FrameIcon = named('frame', 'FrameIcon');
export const ExternalLinkIcon = named('externalLink', 'ExternalLinkIcon');
export const UploadIcon = named('upload', 'UploadIcon');
export const DownloadIcon = named('download', 'DownloadIcon');
export const SendIcon = named('send', 'SendIcon');
export const MirrorIcon = named('mirror', 'MirrorIcon');
export const MergeIcon = named('merge', 'MergeIcon');
export const ScaleIcon = named('scale', 'ScaleIcon');
export const SequenceIcon = named('sequence', 'SequenceIcon');
export const PlayIcon = named('play', 'PlayIcon');
export const PauseIcon = named('pause', 'PauseIcon');
export const StopIcon = named('stop', 'StopIcon');
export const StepForwardIcon = named('stepForward', 'StepForwardIcon');
export const StepBackIcon = named('stepBack', 'StepBackIcon');
export const SkipBackIcon = named('skipBack', 'SkipBackIcon');
export const SpinnerIcon = named('spinner', 'SpinnerIcon');
export const InfoIcon = named('info', 'InfoIcon');
export const WarningIcon = named('warning', 'WarningIcon');
export const ErrorIcon = named('error', 'ErrorIcon');
export const CheckCircleIcon = named('checkCircle', 'CheckCircleIcon');
export const ExitIcon = named('exit', 'ExitIcon');
export const TrashIcon = named('trash', 'TrashIcon');
export const CopyIcon = named('copy', 'CopyIcon');
export const PencilIcon = named('pencil', 'PencilIcon');
export const SaveIcon = named('save', 'SaveIcon');
export const SearchIcon = named('search', 'SearchIcon');
export const FilterIcon = named('filter', 'FilterIcon');
export const SlidersIcon = named('sliders', 'SlidersIcon');
export const GearIcon = named('gear', 'GearIcon');
export const ToggleIcon = named('toggle', 'ToggleIcon');
export const PowerIcon = named('power', 'PowerIcon');
export const EyeIcon = named('eye', 'EyeIcon');
export const EyeOffIcon = named('eyeOff', 'EyeOffIcon');
export const LockIcon = named('lock', 'LockIcon');
export const UnlockIcon = named('unlock', 'UnlockIcon');
export const LinkIcon = named('link', 'LinkIcon');
export const UnlinkIcon = named('unlink', 'UnlinkIcon');
export const FileIcon = named('file', 'FileIcon');
export const DocumentIcon = named('document', 'DocumentIcon');
export const FilePlusIcon = named('filePlus', 'FilePlusIcon');
export const ScriptIcon = named('script', 'ScriptIcon');
export const BlueprintIcon = named('blueprint', 'BlueprintIcon');
export const ModelFileIcon = named('modelFile', 'ModelFileIcon');
export const FolderIcon = named('folder', 'FolderIcon');
export const FolderOpenIcon = named('folderOpen', 'FolderOpenIcon');
export const FolderPlusIcon = named('folderPlus', 'FolderPlusIcon');
export const FolderMoveIcon = named('folderMove', 'FolderMoveIcon');
export const DriveIcon = named('drive', 'DriveIcon');
export const DatabaseIcon = named('database', 'DatabaseIcon');
export const PackageIcon = named('package', 'PackageIcon');
export const PackagePlusIcon = named('packagePlus', 'PackagePlusIcon');
export const CubeIcon = named('cube', 'CubeIcon');
export const CubesIcon = named('cubes', 'CubesIcon');
export const ComponentsIcon = named('components', 'ComponentsIcon');
export const PuzzleIcon = named('puzzle', 'PuzzleIcon');
export const LayersIcon = named('layers', 'LayersIcon');
export const GraphIcon = named('graph', 'GraphIcon');
export const FlowIcon = named('flow', 'FlowIcon');
export const BranchIcon = named('branch', 'BranchIcon');
export const ForkIcon = named('fork', 'ForkIcon');
export const TransitionIcon = named('transition', 'TransitionIcon');
export const ImageIcon = named('image', 'ImageIcon');
export const ImageOffIcon = named('imageOff', 'ImageOffIcon');
export const FilmIcon = named('film', 'FilmIcon');
export const VideoIcon = named('video', 'VideoIcon');
export const CameraIcon = named('camera', 'CameraIcon');
export const ApertureIcon = named('aperture', 'ApertureIcon');
export const CaptionsIcon = named('captions', 'CaptionsIcon');
export const MusicIcon = named('music', 'MusicIcon');
export const VolumeIcon = named('volume', 'VolumeIcon');
export const MuteIcon = named('mute', 'MuteIcon');
export const RadioIcon = named('radio', 'RadioIcon');
export const MegaphoneIcon = named('megaphone', 'MegaphoneIcon');
export const PulseIcon = named('pulse', 'PulseIcon');
export const SparklesIcon = named('sparkles', 'SparklesIcon');
export const WandIcon = named('wand', 'WandIcon');
export const SplineIcon = named('spline', 'SplineIcon');
export const RouteIcon = named('route', 'RouteIcon');
export const WaypointsIcon = named('waypoints', 'WaypointsIcon');
export const AxesIcon = named('axes', 'AxesIcon');
export const OrbitIcon = named('orbit', 'OrbitIcon');
export const CrosshairIcon = named('crosshair', 'CrosshairIcon');
export const TargetIcon = named('target', 'TargetIcon');
export const PointerIcon = named('pointer', 'PointerIcon');
export const ClickIcon = named('click', 'ClickIcon');
export const LassoIcon = named('lasso', 'LassoIcon');
export const SelectBoxIcon = named('selectBox', 'SelectBoxIcon');
export const PaletteIcon = named('palette', 'PaletteIcon');
export const MaterialIcon = named('material', 'MaterialIcon');
export const BrushIcon = named('brush', 'BrushIcon');
export const BucketIcon = named('bucket', 'BucketIcon');
export const EraserIcon = named('eraser', 'EraserIcon');
export const EyedropperIcon = named('eyedropper', 'EyedropperIcon');
export const ScissorsIcon = named('scissors', 'ScissorsIcon');
export const HammerIcon = named('hammer', 'HammerIcon');
export const RetextureIcon = named('retexture', 'RetextureIcon');
export const GridIcon = named('grid', 'GridIcon');
export const TilesIcon = named('tiles', 'TilesIcon');
export const LayoutIcon = named('layout', 'LayoutIcon');
export const PanelIcon = named('panel', 'PanelIcon');
export const ViewSingleIcon = named('viewSingle', 'ViewSingleIcon');
export const ViewQuadIcon = named('viewQuad', 'ViewQuadIcon');
export const CompareIcon = named('compare', 'CompareIcon');
export const TerraceIcon = named('terrace', 'TerraceIcon');
export const MountainIcon = named('mountain', 'MountainIcon');
export const TreesIcon = named('trees', 'TreesIcon');
export const TreeIcon = named('tree', 'TreeIcon');
export const SmoothIcon = named('smooth', 'SmoothIcon');
export const RampIcon = named('ramp', 'RampIcon');
export const DropletsIcon = named('droplets', 'DropletsIcon');
export const WindIcon = named('wind', 'WindIcon');
export const CircleDashedIcon = named('circleDashed', 'CircleDashedIcon');
export const SunIcon = named('sun', 'SunIcon');
export const SunDimIcon = named('sunDim', 'SunDimIcon');
export const MoonIcon = named('moon', 'MoonIcon');
export const CloudIcon = named('cloud', 'CloudIcon');
export const RainIcon = named('rain', 'RainIcon');
export const FogIcon = named('fog', 'FogIcon');
export const BulbIcon = named('bulb', 'BulbIcon');
export const SpotlightIcon = named('spotlight', 'SpotlightIcon');
export const GlobeIcon = named('globe', 'GlobeIcon');
export const MagnetIcon = named('magnet', 'MagnetIcon');
export const PinIcon = named('pin', 'PinIcon');
export const UserIcon = named('user', 'UserIcon');
export const UsersIcon = named('users', 'UsersIcon');
export const UserPlusIcon = named('userPlus', 'UserPlusIcon');
export const PersonIcon = named('person', 'PersonIcon');
export const FootprintsIcon = named('footprints', 'FootprintsIcon');
export const BoneIcon = named('bone', 'BoneIcon');
export const FaceIcon = named('face', 'FaceIcon');
export const SkullIcon = named('skull', 'SkullIcon');
export const ShieldIcon = named('shield', 'ShieldIcon');
export const CrownIcon = named('crown', 'CrownIcon');
export const SwordsIcon = named('swords', 'SwordsIcon');
export const BombIcon = named('bomb', 'BombIcon');
export const FlameIcon = named('flame', 'FlameIcon');
export const HeartIcon = named('heart', 'HeartIcon');
export const HealthIcon = named('health', 'HealthIcon');
export const DamageIcon = named('damage', 'DamageIcon');
export const GamepadIcon = named('gamepad', 'GamepadIcon');
export const KeyboardIcon = named('keyboard', 'KeyboardIcon');
export const DiceIcon = named('dice', 'DiceIcon');
export const CarIcon = named('car', 'CarIcon');
export const DoorIcon = named('door', 'DoorIcon');
export const DoorOpenIcon = named('doorOpen', 'DoorOpenIcon');
export const ChatIcon = named('chat', 'ChatIcon');
export const CommentAddIcon = named('commentAdd', 'CommentAddIcon');
export const LanguagesIcon = named('languages', 'LanguagesIcon');
export const BookIcon = named('book', 'BookIcon');
export const KeyIcon = named('key', 'KeyIcon');
export const PaperclipIcon = named('paperclip', 'PaperclipIcon');
export const ChipIcon = named('chip', 'ChipIcon');
export const OfflineIcon = named('offline', 'OfflineIcon');
export const CalculatorIcon = named('calculator', 'CalculatorIcon');
export const CheckboxIcon = named('checkbox', 'CheckboxIcon');
export const BrainIcon = named('brain', 'BrainIcon');
export const BellIcon = named('bell', 'BellIcon');
export const TagIcon = named('tag', 'TagIcon');
export const FlagIcon = named('flag', 'FlagIcon');
export const StarIcon = named('star', 'StarIcon');
export const HistoryIcon = named('history', 'HistoryIcon');
export const ClockIcon = named('clock', 'ClockIcon');
export const TimerIcon = named('timer', 'TimerIcon');
export const BoltIcon = named('bolt', 'BoltIcon');
export const BoltOffIcon = named('boltOff', 'BoltOffIcon');
