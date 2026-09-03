import React, { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  label: string;
  value: string | number | boolean;
}

interface SelectProps {
  value: string | number | boolean;
  onChange: (value: any) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({ 
  value, 
  onChange, 
  options, 
  placeholder = "Select...", 
  className = "", 
  disabled = false 
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectId = useId().replaceAll(':', '');
  const listboxId = `select-${selectId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);

  const optionId = (index: number) => `select-${selectId}-option-${index}`;
  const closeMenu = () => {
    setIsOpen(false);
    setActiveIndex(-1);
  };
  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : (options.length > 0 ? 0 : -1));
    setIsOpen(true);
  };
  const selectOption = (option: SelectOption) => {
    onChange(option.value);
    closeMenu();
  };

  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(-1);
      return;
    }
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex((current) => (
      current >= 0 && current < options.length
        ? current
        : selectedIndex >= 0 ? selectedIndex : (options.length > 0 ? 0 : -1)
    ));
  }, [isOpen, options, value]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      if (options.length === 0) return;
      setActiveIndex((current) => {
        const start = current < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : current;
        return event.key === 'ArrowDown'
          ? (start + 1) % options.length
          : (start - 1 + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!isOpen || options.length === 0) return;
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      } else if (activeIndex >= 0 && options[activeIndex]) {
        selectOption(options[activeIndex]);
      } else {
        closeMenu();
      }
      return;
    }
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  };

  // Calculate position and handle listeners
  useEffect(() => {
    if (isOpen && containerRef.current) {
        const updatePosition = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setPosition({
                    top: rect.bottom + window.scrollY + 4,
                    left: rect.left + window.scrollX,
                    width: rect.width
                });
            }
        };
        
        updatePosition();
        
        // Listen to scroll (capture phase) to handle scrolling of parent containers
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);
        
        return () => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        }
    }
  }, [isOpen]);

  // Handle click outside for both container and portal
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideContainer = containerRef.current && containerRef.current.contains(target);
      const isInsideDropdown = dropdownRef.current && dropdownRef.current.contains(target);

      if (!isInsideContainer && !isInsideDropdown) {
        setIsOpen(false);
      }
    };
    
    if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const selectedOption = options.find(opt => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={placeholder}
        onClick={() => isOpen ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        className={`
          w-full flex items-center justify-between px-3 py-2 bg-gray-900 border rounded text-xs text-left transition-all
          ${disabled 
            ? 'opacity-50 cursor-not-allowed border-gray-800' 
            : 'hover:border-gray-600 border-gray-700 bg-gray-900/50 hover:bg-gray-800'
          }
          ${isOpen ? 'border-blue-500 ring-1 ring-blue-500/20' : ''}
        `}
      >
        <span className={`truncate mr-2 ${selectedOption ? 'text-gray-200' : 'text-gray-500'}`}>
          {displayLabel}
        </span>
        <ChevronDown 
          size={14} 
          className={`text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} 
        />
      </button>

      {isOpen && createPortal(
        <div 
          ref={dropdownRef}
          id={listboxId}
          role="listbox"
          aria-label={placeholder}
          style={{ 
              top: position.top, 
              left: position.left, 
              width: position.width,
              position: 'absolute'
          }}
          className="z-[9999] bg-gray-800 border border-gray-700 rounded-md shadow-xl max-h-60 overflow-y-auto custom-scrollbar animate-in fade-in zoom-in-95 duration-100"
        >
          {options.length === 0 ? (
             <div className="px-3 py-2 text-gray-500 text-[10px] italic text-center">No options available</div>
          ) : (
             <div className="p-1 space-y-0.5">
               {options.map((opt, idx) => {
                 const isSelected = opt.value === value;
                 return (
                  <button
                    key={`${String(opt.value)}-${idx}`}
                    id={optionId(idx)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => selectOption(opt)}
                    className={`
                      w-full flex items-center justify-between px-2 py-1.5 text-xs text-left rounded transition-colors
                      ${isSelected ? 'bg-blue-900/30 text-blue-400' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}
                    `}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected && <Check size={12} />}
                  </button>
                 );
               })}
             </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};
