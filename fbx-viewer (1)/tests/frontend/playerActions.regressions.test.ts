import { describe, expect, it, vi } from 'vitest';
import { playerActions } from '../../runtime/playerActions';

describe('overlapping player action registrations', () => {
  it('restores a still-mounted handler when the newer override unregisters first', () => {
    const olderHeal = vi.fn(() => true);
    const offOlder = playerActions.register({ heal: olderHeal });
    const offNewer = playerActions.register({ heal: () => false });

    expect(playerActions.heal(10)).toBe(false);
    offNewer();
    expect(playerActions.heal(10)).toBe(true);
    offNewer(); // Cleanup may be called twice; it must not remove the older handler.
    expect(playerActions.heal(10)).toBe(true);
    offOlder();
    expect(playerActions.heal(10)).toBe(false);
    expect(olderHeal).toHaveBeenCalledTimes(2);
  });

  it('removes a middle registration without disturbing newer or older registrations', () => {
    const sharedHeal = vi.fn(() => true);
    const offOlder = playerActions.register({ heal: sharedHeal });
    const offMiddle = playerActions.register({ heal: () => false });
    const offNewer = playerActions.register({ heal: sharedHeal });

    expect(playerActions.heal(1)).toBe(true);
    offMiddle();
    expect(playerActions.heal(1)).toBe(true);
    offNewer();
    expect(playerActions.heal(1)).toBe(true);
    offOlder();
    expect(playerActions.heal(1)).toBe(false);
    expect(sharedHeal).toHaveBeenCalledTimes(3);
  });

  it('tracks separate registrations of the same callback by owner, not function identity', () => {
    const sharedHeal = vi.fn(() => true);
    const offOlder = playerActions.register({ heal: sharedHeal });
    const offNewer = playerActions.register({ heal: sharedHeal });
    offOlder();
    expect(playerActions.heal(1)).toBe(true);
    offNewer();
    expect(playerActions.heal(1)).toBe(false);
  });

  it('keeps partial action overrides independent', () => {
    const damage = vi.fn(() => true);
    const addAmmo = vi.fn(() => true);
    const giveWeapon = vi.fn(() => true);
    const offOlder = playerActions.register({ damage, heal: () => true, addAmmo });
    const offNewer = playerActions.register({ heal: () => false, giveWeapon });

    expect(playerActions.damage(5)).toBe(true);
    expect(playerActions.heal(5)).toBe(false);
    expect(playerActions.addAmmo(3, 'Pistol')).toBe(true);
    expect(playerActions.giveWeapon('Rifle')).toBe(true);
    offNewer();
    expect(playerActions.damage(5)).toBe(true);
    expect(playerActions.heal(5)).toBe(true);
    expect(playerActions.addAmmo(3)).toBe(true);
    expect(playerActions.giveWeapon('Rifle')).toBe(false);
    offOlder();
    expect(playerActions.damage(5)).toBe(false);
    expect(playerActions.heal(5)).toBe(false);
    expect(playerActions.addAmmo(3)).toBe(false);
    expect(damage).toHaveBeenCalledTimes(2);
    expect(addAmmo).toHaveBeenCalledWith(3, 'Pistol');
    expect(addAmmo).toHaveBeenCalledWith(3, null);
    expect(giveWeapon).toHaveBeenCalledWith('Rifle');
  });
});
