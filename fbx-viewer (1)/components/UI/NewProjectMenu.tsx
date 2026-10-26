import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FilePlus } from 'lucide-react';
import type { ProjectTemplate } from '../../types';

export interface ProjectTemplateOption {
  template: ProjectTemplate;
  label: string;
  description: string;
}

/** Templates offered when creating a project, in menu order. */
export const PROJECT_TEMPLATE_OPTIONS: readonly ProjectTemplateOption[] = [
  { template: 'blank', label: 'Blank project', description: 'An empty project to build from scratch' },
  { template: 'starter', label: 'Starter', description: 'A walkable level with terrain, sky, player and props' },
  { template: 'arena', label: 'Arena Sample', description: 'A complete small game: coins, physics, HUD and menus' },
];

interface NewProjectMenuProps {
  /** Called once with the chosen template; the menu is already closed. */
  onCreate: (template: ProjectTemplate) => void;
  /** True while a project operation runs: the trigger is disabled and an open menu closes. */
  disabled?: boolean;
  /** Shows a note that the open project has unsaved changes. */
  unsavedChanges?: boolean;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab', 'Enter', ' ']);

/**
 * The header "New" button: a menu button (WAI-ARIA menu pattern) listing the
 * project templates. The menu is portalled to the body because the header's
 * project controls scroll horizontally and would clip a dropdown.
 */
export const NewProjectMenu: React.FC<NewProjectMenuProps> = ({ onCreate, disabled = false, unsavedChanges = false }) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = `new-project-${useId().replaceAll(':', '')}`;
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;
  const lastIndex = PROJECT_TEMPLATE_OPTIONS.length - 1;

  const openMenu = (index: number) => {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  };
  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const choose = (template: ProjectTemplate) => {
    closeMenu(true);
    onCreate(template);
  };

  // A project operation started elsewhere closes the menu so nothing can be chosen while busy.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Roving focus: the active item holds focus while the menu is open.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // Fixed position under the trigger, kept inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth ?? 0;
      const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
      setPosition({ top: rect.bottom + MENU_GAP, left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Pressing outside the trigger and the menu dismisses it without moving focus.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space reach onClick natively.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.key === 'ArrowDown' ? 0 : lastIndex);
    }
  };

  // Menu keys stop here so window-level editor hotkeys (Escape, arrows, Space) do not also act on
  // them; Enter and Space keep their default action, which clicks the focused item.
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (MENU_KEYS.has(event.key)) event.stopPropagation();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % PROJECT_TEMPLATE_OPTIONS.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + PROJECT_TEMPLATE_OPTIONS.length) % PROJECT_TEMPLATE_OPTIONS.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(lastIndex);
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        break;
      case 'Tab':
        // Return focus to the trigger; the browser's default Tab then moves on from there.
        closeMenu(true);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu(0))}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        className={`flex items-center gap-2 px-3 py-1 text-xs font-bold rounded transition-colors disabled:opacity-50 ${open ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
        title="Create a new project from a template"
      >
        <FilePlus size={12} /> New <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          style={{ position: 'fixed', top: position.top, left: position.left }}
          className="z-[9999] w-72 rounded-md border border-gray-700 bg-gray-900 p-1 shadow-xl"
        >
          {unsavedChanges && (
            <div className="px-2 pb-1 pt-0.5 text-[10px] text-amber-400">The open project has unsaved changes.</div>
          )}
          {PROJECT_TEMPLATE_OPTIONS.map((option, index) => (
            <button
              key={option.template}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-labelledby={`${baseId}-${option.template}-label`}
              aria-describedby={`${baseId}-${option.template}-description`}
              onClick={() => choose(option.template)}
              onMouseEnter={() => setActiveIndex(index)}
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none hover:bg-gray-800 focus:bg-gray-800 focus-visible:ring-1 focus-visible:ring-blue-500"
            >
              <span id={`${baseId}-${option.template}-label`} className="text-xs font-bold text-gray-200">{option.label}</span>
              <span id={`${baseId}-${option.template}-description`} className="whitespace-normal text-[10px] text-gray-500">{option.description}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};
