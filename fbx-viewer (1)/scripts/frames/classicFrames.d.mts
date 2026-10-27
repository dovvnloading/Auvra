import type { Plugin } from 'vite';

export interface SandboxFrame {
  page: string;
  entry: string;
  name: string;
  stylesheet: boolean;
}

export const SANDBOX_FRAMES: SandboxFrame[];
export function devFrameScript(frame: SandboxFrame): string;
export function classicFramePage(html: string, src: string, stylesheet?: string | null): string;
export function classicSandboxFrames(options: { root: string; frameCsp: string }): Plugin;
