
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

export interface HUDComponentDefinition {
  type: string;
  label: string;
  defaultProps: Record<string, any>;
  defaultSize: { width: number; height: number };
  icon?: React.ReactNode;
}
