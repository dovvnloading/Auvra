import React, { useState } from 'react';
import { DownloadIcon } from '../../UI/Icons';
import { Button } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { PICTURE_FORMATS, type PictureFormat } from '../../../texturing/paint/pictureFiles';

/** A Download pictures button with the file kind beside it (PNG, TGA, TIFF, EXR at their bit depths). */
export const DownloadPicturesButton: React.FC<{ disabled: boolean; onDownload: (format: PictureFormat) => void }> = ({ disabled, onDownload }) => {
    const [format, setFormat] = useState<PictureFormat>('png8');
    return (
        <div className="flex items-center gap-1.5">
            <Button size="sm" className="min-w-0 flex-1 justify-center" disabled={disabled} onClick={() => onDownload(format)} icon={<DownloadIcon size={12} />}>Download pictures</Button>
            <Select value={format} options={PICTURE_FORMATS.map((each) => ({ value: each.value, label: each.label }))} onChange={(value) => setFormat(value as PictureFormat)} disabled={disabled} className="w-36" />
        </div>
    );
};
