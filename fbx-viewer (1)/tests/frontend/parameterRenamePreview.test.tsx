import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { ParameterRenamePreview, projectRenamePreview } from '../../components/Texturing/ParameterRenamePreview';

const preview = () => projectRenamePreview({
    impact: { sourceMaterialId: "graph's-id", from: 'Wear', to: 'Patina', materials: ["graph's-id"], models: [], objects: [],
        prefabs: ['kit'], metadata: [], nestedNodes: 0, paintReferences: 0, modelOverrides: 0, objectOverrides: 0,
        prefabOverrides: 2, sharedPresets: 0 },
    changes: [{ domain: 'materials', operation: 'upsert', value: { id: "graph's-id", name: 'Finish' } },
        { domain: 'prefabs', operation: 'upsert', value: { id: 'kit', name: 'Workshop' } }], undoChanges: [], changedMaterials: [],
}, 'project-id', 12, materialLibrary.version, 1);

afterEach(cleanup);

describe('project parameter rename preview', () => {
    it('shows the saved references and copies a preview with a quoted project folder and stable asset id', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        render(<ParameterRenamePreview preview={preview()} stale={false} onRefresh={() => {}} onDismiss={() => {}} />);
        expect(screen.getByText('Prefab member overrides').nextElementSibling).toHaveTextContent('2');
        expect(screen.getByText(/prefabs \/ Workshop/)).toHaveTextContent('kit');
        const copy = screen.getByRole('button', { name: 'Copy preview command' });
        expect(copy).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: "C:\\my work\\Pat's project" } });
        fireEvent.click(copy);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(
            "python -m Auvra.project.material_commands 'C:\\my work\\Pat''s project' rename-parameter -- 'graph''s-id' 'Wear' 'Patina'",
        ));
        fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: "C:\\O’Connor $(sample)" } });
        const quoted = screen.getByRole('textbox', { name: 'PowerShell preview command' }) as HTMLTextAreaElement;
        const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(quoted.value)![1];
        expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), letter => letter.charCodeAt(0)))).toBe("C:\\O’Connor $(sample)");
        expect(screen.getByRole('textbox', { name: 'PowerShell preview command' })).toHaveAttribute('readonly');
    });

    it('withdraws a stale preview and exposes only refresh and dismissal', () => {
        const refresh = vi.fn(), dismiss = vi.fn();
        render(<ParameterRenamePreview preview={preview()} stale onRefresh={refresh} onDismiss={dismiss} />);
        expect(screen.queryByText('Copy preview command')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(refresh).toHaveBeenCalledOnce();
        expect(dismiss).toHaveBeenCalledOnce();
    });
    it('offers a live project apply only for a current writable preflight', () => {
        const apply = vi.fn();
        const view = render(<ParameterRenamePreview preview={preview()} stale={false}
            onRefresh={() => {}} onDismiss={() => {}} onApply={apply} />);
        fireEvent.click(screen.getByRole('button', { name: 'Apply rename to project' }));
        expect(apply).toHaveBeenCalledOnce();
        view.rerender(<ParameterRenamePreview preview={preview()} stale
            onRefresh={() => {}} onDismiss={() => {}} onApply={apply} />);
        expect(screen.queryByRole('button', { name: 'Apply rename to project' })).not.toBeInTheDocument();
        view.rerender(<ParameterRenamePreview preview={preview()} stale={false} readOnly
            onRefresh={() => {}} onDismiss={() => {}} onApply={apply} />);
        expect(screen.queryByRole('button', { name: 'Apply rename to project' })).not.toBeInTheDocument();
        expect(screen.getByText(/read-only/)).toBeInTheDocument();
    });

});
