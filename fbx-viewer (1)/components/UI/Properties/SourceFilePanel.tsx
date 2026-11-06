import React, { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, ModelFileIcon } from '../Icons';
import type { ModelFileReport } from '../../../utils/fbxImport/nativeImporter';

const number = (value: number): string => value.toLocaleString();

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <>
    <dt className="text-ink-3">{label}</dt>
    <dd className="min-w-0 truncate text-ink-2 tabular-nums">{children}</dd>
  </>
);

/** What a model's source file held and what was made of it, with anything worth knowing about it. */
export const SourceFilePanel: React.FC<{ report: ModelFileReport }> = ({ report }) => {
  const [open, setOpen] = useState(false);
  const maker = report.application || report.creator;
  const format = report.format === 'fbx' ? `FBX ${(report.version / 1000).toFixed(1)}` : report.format === 'obj' ? 'OBJ' : 'glTF';
  const tangents = report.tangentsGenerated + report.tangentsFromFile;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-t border-gray-800 px-4 pb-2 pt-2 text-xs font-semibold text-gray-400 hover:text-gray-200"
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <ModelFileIcon size={12} /> Source file
        {report.warnings.length > 0 && <span className="ml-auto text-2xs font-normal text-amber-400">{report.warnings.length === 1 ? '1 note' : `${report.warnings.length} notes`}</span>}
      </button>
      {open && (
        <div className="px-4 pb-2">
          <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-0.5 text-2xs">
            <Fact label="Format">{format}</Fact>
            {maker && <Fact label="Made with">{maker}</Fact>}
            {report.outputTriangles > 0 && <Fact label="Triangles">{number(report.outputTriangles)}</Fact>}
            {report.outputVertices > 0 && <Fact label="Vertices">{number(report.outputVertices)}</Fact>}
            {report.materials > 0 && <Fact label="Materials">{number(report.materials)}</Fact>}
            {report.bones > 0 && <Fact label="Bones">{number(report.bones)}</Fact>}
            {report.maxInfluences > 4 && <Fact label="Per vertex">{report.maxInfluences} bones in the file, strongest 4 kept</Fact>}
            {report.blendShapes > 0 && <Fact label="Blend shapes">{number(report.blendShapes)}</Fact>}
            {report.clips.length > 0 && <Fact label="Clips">{number(report.clips.length)}</Fact>}
            {tangents > 0 && <Fact label="Tangents">{report.tangentsFromFile > 0 && !report.tangentsGenerated ? 'From the file' : 'Generated'}</Fact>}
          </dl>
          {report.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-2xs text-amber-400">{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
};
