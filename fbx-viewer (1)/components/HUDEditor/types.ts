
import React from 'react';

export interface HUDElement {
  id: string;
  name: string;
  type: string; // Maps to component registry key
  props: Record<string, any>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  isVisible: boolean;
  isLocked: boolean;
  align?: 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right';
}

export interface HUDLayout {
  width: number;
  height: number;
}

export const HUD_REFERENCE_SIZE: Readonly<HUDLayout> = { width: 1920, height: 1080 };

export function normalizeHUDLayout(layout?: Partial<HUDLayout> | null): HUDLayout {
  return {
    width: Number.isFinite(layout?.width) && (layout?.width ?? 0) > 0 ? layout!.width! : HUD_REFERENCE_SIZE.width,
    height: Number.isFinite(layout?.height) && (layout?.height ?? 0) > 0 ? layout!.height! : HUD_REFERENCE_SIZE.height,
  };
}

export function clampHUDPosition(
  position: HUDElement['position'],
  size: HUDElement['size'],
  layout: HUDLayout,
): HUDElement['position'] {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 0;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 0;
  const x = Number.isFinite(position.x) ? position.x : 0;
  const y = Number.isFinite(position.y) ? position.y : 0;
  return {
    x: Math.min(Math.max(0, layout.width - width), Math.max(0, x)),
    y: Math.min(Math.max(0, layout.height - height), Math.max(0, y)),
  };
}

export interface HUDComponentDefinition {
  type: string;
  label: string;
  defaultProps: Record<string, any>;
  defaultSize: { width: number; height: number };
  icon?: React.ReactNode;
}
