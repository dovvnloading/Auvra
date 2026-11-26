import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetSessionContext } from '../../runtime/net/NetSessionContext';
import { NetStatus } from '../../runtime/net/NetStatus';
import type { NetSession } from '../../runtime/net/protocol';

const makeSession = (host = false) => {
  const setHostToken = vi.fn<(token: string) => string | null>(() => null);
  const session = {
    status: () => host ? 'connected' : 'error',
    statusMessage: () => host ? '' : 'Waiting for an authenticated host',
    peers: () => [],
    isHost: () => host,
    onChange: () => () => undefined,
    setHostToken,
  } as unknown as NetSession;
  return { session, setHostToken };
};

const badge = (session: NetSession) => (
  <NetSessionContext.Provider value={session}>
    <NetStatus />
  </NetSessionContext.Provider>
);

afterEach(cleanup);

describe('runtime host credentials', () => {
  it('requires explicit entry, masks the field and removes it after submission', () => {
    const { session, setHostToken } = makeSession();
    render(badge(session));
    expect(setHostToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Host credentials' }));
    const input = screen.getByLabelText('Host credential (this session only)') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    const credential = 'A'.repeat(43);
    fireEvent.change(input, { target: { value: credential } });
    fireEvent.click(screen.getByRole('button', { name: 'Host room' }));
    expect(setHostToken).toHaveBeenCalledOnce();
    expect(setHostToken).toHaveBeenCalledWith(credential);
    expect(screen.queryByLabelText('Host credential (this session only)')).toBeNull();
  });

  it('clears rejected drafts and can explicitly switch back to a guest', () => {
    const { session, setHostToken } = makeSession();
    setHostToken.mockReturnValueOnce('Invalid credential');
    render(badge(session));
    fireEvent.click(screen.getByRole('button', { name: 'Host credentials' }));
    const input = screen.getByLabelText('Host credential (this session only)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Host room' }));
    expect(screen.getByRole('alert').textContent).toBe('Invalid credential');
    expect((screen.getByLabelText('Host credential (this session only)') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Join as player' }));
    expect(setHostToken).toHaveBeenLastCalledWith('');
    expect(screen.queryByLabelText('Host credential (this session only)')).toBeNull();
  });

  it('never carries an unsubmitted credential to a different connection', () => {
    const first = makeSession();
    const second = makeSession();
    const { rerender } = render(badge(first.session));
    fireEvent.click(screen.getByRole('button', { name: 'Host credentials' }));
    fireEvent.change(screen.getByLabelText('Host credential (this session only)'), { target: { value: 'A'.repeat(43) } });
    rerender(badge(second.session));
    expect(screen.queryByLabelText('Host credential (this session only)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Host credentials' }));
    expect((screen.getByLabelText('Host credential (this session only)') as HTMLInputElement).value).toBe('');
    expect(first.setHostToken).not.toHaveBeenCalled();
    expect(second.setHostToken).not.toHaveBeenCalled();
  });

  it('does not present a reauthentication control to an already connected host', () => {
    const { session } = makeSession(true);
    render(badge(session));
    expect(screen.getByRole('status').textContent).toContain('host');
    expect(screen.queryByRole('button', { name: 'Host credentials' })).toBeNull();
  });
});
