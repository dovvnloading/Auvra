import React, { useState, useRef, useEffect } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

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
        onClick={() => !disabled && setIsOpen(!isOpen)}
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
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setIsOpen(false);
                    }}
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