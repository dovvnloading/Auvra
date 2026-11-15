import React, { useEffect, useRef, useState } from 'react';
import { download } from '../../../texturing/zip';
import { parseGuideProfile } from '../../../utils/autoRig/guideProfile';
import { applyRigGuideProfile, getRigGuideProfile } from '../../../utils/autoRig/rigSession';
import { Button } from '../kit';

export const RigGuideProfiles: React.FC<{ modelName: string; edited: boolean }> = ({ modelName, edited }) => {
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [message, setMessage] = useState('');
  useEffect(() => () => { request.current++; }, []);
  const load = async (file: File) => {
    const ticket = ++request.current;
    try {
      if (file.size > 64 * 1024) throw new Error('Choose a guide profile smaller than 64 KiB.');
      const profile = parseGuideProfile(await file.text());
      if (ticket !== request.current) return;
      applyRigGuideProfile(profile);
      setMessage(`Loaded ${file.name}.`);
    } catch (error) {
      if (ticket === request.current) setMessage(error instanceof SyntaxError ? 'Choose a valid guide profile JSON file.' : error instanceof Error ? error.message : 'The guide profile could not be loaded.');
    }
  };
  const save = () => {
    const profile = getRigGuideProfile();
    if (!profile) return;
    download(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }), `${modelName.replace(/\.[^.]*$/, '')}.guides.json`);
    setMessage('Guide profile exported.');
  };
  return (
    <details className="border-b border-line px-3 py-2.5">
      <summary className="text-2xs font-medium text-ink-2">Guide profiles</summary>
      <p className="my-2 text-2xs leading-relaxed">Reuse your guide offsets on another mesh of the same body type. Loading replaces the current edits in one undo step.</p>
      <div className="flex gap-1.5"><Button size="sm" onClick={() => input.current?.click()}>Load profile</Button>
        <Button size="sm" disabled={!edited} onClick={save}>Save profile</Button></div>
      <input ref={input} type="file" hidden aria-label="Load guide profile" accept=".json,application/json" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void load(file);
      }} />
      {message && <p role="status" className="mt-1.5 break-words text-2xs">{message}</p>}
    </details>
  );
};
