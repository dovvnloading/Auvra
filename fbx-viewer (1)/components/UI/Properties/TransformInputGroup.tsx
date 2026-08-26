import React from 'react';
import { ScrubbableInput } from './ScrubbableInput';

interface TransformInputGroupProps {
  label: string;
  values: [number, number, number];
  onChange: (val: [number, number, number]) => void;
  step: number;
}

export const TransformInputGroup: React.FC<TransformInputGroupProps> = ({ label, values, onChange, step }) => {
  
  const handleChange = (index: number, val: number) => {
    const newValues = [...values] as [number, number, number];
    newValues[index] = val;
    onChange(newValues);
  };

  return (
    <div className="space-y-1.5">
      <div className="text-[9px] text-gray-500 font-bold uppercase tracking-wider pl-0.5">{label}</div>
      <div className="grid grid-cols-3 gap-2">
         <ScrubbableInput 
            label="X" 
            value={values[0]} 
            onChange={(v) => handleChange(0, v)} 
            step={step} 
            labelColor="text-red-400"
         />
         <ScrubbableInput 
            label="Y" 
            value={values[1]} 
            onChange={(v) => handleChange(1, v)} 
            step={step} 
            labelColor="text-green-400"
         />
         <ScrubbableInput 
            label="Z" 
            value={values[2]} 
            onChange={(v) => handleChange(2, v)} 
            step={step} 
            labelColor="text-blue-400"
         />
      </div>
    </div>
  );
};