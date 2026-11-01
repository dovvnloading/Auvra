import React, { useEffect, useState } from 'react';
import { Box, X } from 'lucide-react';
import { DEFAULT_MODEL_IMPORT_SETTINGS, ModelImportSettings } from '../../../types';
import { MAX_MODEL_TARGET_SIZE, resolveImportSettings } from '../../../utils/processing/ModelTransforms';

interface ImportOptionsDialogProps {
  /** The file being imported, or the model whose size is being changed. */
  name: string;
  /** Starting values, e.g. a model's stored settings; defaults to DEFAULT_MODEL_IMPORT_SETTINGS. */
  initialSettings?: ModelImportSettings;
  /** The confirm button: 'Import' for a new file, 'Apply' for an imported model. */
  confirmLabel?: string;
  onConfirm: (settings: ModelImportSettings) => void;
  onCancel: () => void;
}

/** Per-model import options: fit the model to a target size, or keep its authored scale. */
export const ImportOptionsDialog: React.FC<ImportOptionsDialogProps> = ({ name, initialSettings, confirmLabel = 'Import', onConfirm, onCancel }) => {
  const start = resolveImportSettings(initialSettings ?? DEFAULT_MODEL_IMPORT_SETTINGS);
  const [normalize, setNormalize] = useState(start.normalize);
  const [targetSize, setTargetSize] = useState(String(start.targetSize));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const size = Number(targetSize);
  const sizeValid = Number.isFinite(size) && size > 0 && size <= MAX_MODEL_TARGET_SIZE;
  const canConfirm = !normalize || sizeValid;
  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(resolveImportSettings({ normalize, targetSize: sizeValid ? size : start.targetSize }));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="Import options">
      <form
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onSubmit={(event) => { event.preventDefault(); confirm(); }}
      >
        <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Box size={18} className="shrink-0 text-blue-400" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white">Import Options</h2>
              <p className="truncate text-2xs text-gray-500" title={name}>{name}</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Cancel import"><X size={16} /></button>
        </div>
        <div className="space-y-3 p-5">
          <label className="flex items-center justify-between gap-3 text-xs text-gray-300">
            <span>Normalize size</span>
            <input type="checkbox" aria-label="Normalize size" checked={normalize} onChange={(event) => setNormalize(event.target.checked)} className="h-4 w-4 accent-blue-500" />
          </label>
          <p className="text-2xs text-gray-500">
            {normalize
              ? 'Scales the model so its largest dimension matches the target size, centred and resting on the floor.'
              : 'Keeps the authored size and pivot from the source file, in metres when the file says what unit it is in (FBX).'}
          </p>
          <label className="block text-2xs text-gray-500">Target size (metres)
            <input
              type="number"
              aria-label="Target size"
              min={0.001}
              max={MAX_MODEL_TARGET_SIZE}
              step="any"
              value={targetSize}
              disabled={!normalize}
              onChange={(event) => setTargetSize(event.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </label>
          {normalize && !sizeValid && <p className="text-2xs text-amber-400">Enter a size greater than 0.</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-800 bg-gray-950 px-5 py-3">
          <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
          <button type="submit" disabled={!canConfirm} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-blue-500 disabled:opacity-50">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
};

export default ImportOptionsDialog;
