import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface MenuButtonItem {
  label: string;
  description?: string;
  /** Items of a group sit together under this heading, in the order given. */
  group?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuButtonProps {
  label: string;
  icon?: React.ReactNode;
  title?: string;
  items: readonly MenuButtonItem[];
  /** Shows only the icon, the label still naming it. */
  hideLabel?: boolean;
  /** Disables the trigger; an open menu closes. */
  disabled?: boolean;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab', 'Enter', ' ']);

/**
 * A header button that opens a menu of actions (WAI-ARIA menu pattern), for actions used too
 * rarely to keep their own button. Portalled to the body so the scrolling header cannot clip it.
 */
export const MenuButton: React.FC<MenuButtonProps> = ({ label, icon, title, items, hideLabel = false, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = `menu-${useId().replaceAll(':', '')}`;
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;
  const lastIndex = items.length - 1;

  const openMenu = (index: number) => {
    if (disabled || !items.length) return;
    setActiveIndex(index);
    setOpen(true);
  };
  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const choose = (item: MenuButtonItem) => {
    if (item.disabled) return;
    closeMenu(true);
    item.onSelect();
  };

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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.key === 'ArrowDown' ? 0 : lastIndex);
    }
  };

  // Menu keys stop here so window-level editor hotkeys do not also act on them.
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (MENU_KEYS.has(event.key)) event.stopPropagation();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + items.length) % items.length);
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
        aria-label={hideLabel ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu(0))}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        className={`flex h-6 items-center gap-1.5 rounded px-2 text-xs transition-colors duration-75 disabled:opacity-40 ${open ? 'bg-white/10 text-ink' : 'text-ink-2 hover:bg-white/5 hover:text-ink'}`}
        title={title}
      >
        {icon}{!hideLabel && label}<ChevronDown size={11} className="text-ink-3" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          style={{ position: 'fixed', top: position.top, left: position.left }}
          className="z-[9999] max-h-[80vh] w-64 overflow-y-auto rounded-lg border border-line bg-panel py-1 shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
        >
          {items.map((item, index) => (
            <React.Fragment key={`${item.group ?? ''}/${item.label}/${index}`}>
            {item.group && item.group !== items[index - 1]?.group && (
              <div className="mt-1 border-t border-line px-3 pb-0.5 pt-1.5 text-2xs text-ink-3">{item.group}</div>
            )}
            <button
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-disabled={item.disabled || undefined}
              onClick={() => choose(item)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`flex w-full flex-col items-start px-3 py-1 text-left outline-none focus:bg-white/5 ${item.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              <span className="w-full truncate text-xs text-ink">{item.label}</span>
              {item.description && <span className="whitespace-normal text-2xs text-ink-3">{item.description}</span>}
            </button>
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};
