import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface MenuButtonItem {
  label: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuButtonProps {
  label: string;
  icon?: React.ReactNode;
  title?: string;
  items: readonly MenuButtonItem[];
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
export const MenuButton: React.FC<MenuButtonProps> = ({ label, icon, title, items, disabled = false }) => {
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu(0))}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        className={`flex items-center gap-2 px-3 py-1 text-xs font-bold rounded transition-colors disabled:opacity-50 ${open ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
        title={title}
      >
        {icon} {label} <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
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
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-disabled={item.disabled || undefined}
              onClick={() => choose(item)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left outline-none hover:bg-gray-800 focus:bg-gray-800 focus-visible:ring-1 focus-visible:ring-blue-500 ${item.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <span className="text-xs font-bold text-gray-200">{item.label}</span>
              {item.description && <span className="whitespace-normal text-[10px] text-gray-500">{item.description}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};
