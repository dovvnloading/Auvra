import { describe, expect, it } from 'vitest';
import { AXIS_INDEX, acrossOf, folded, projectedUv } from '../../texturing/paint/projections';

const space = { centre: [0, 0, 0] as const, extent: 2, offset: 0.5 };

describe('laying pictures on', () => {
    it('lays flat along an axis: the place on the plane square to it', () => {
        expect(acrossOf(AXIS_INDEX.x)).toEqual([2, 1]);
        expect(acrossOf(AXIS_INDEX.y)).toEqual([0, 2]);
        expect(acrossOf(AXIS_INDEX.z)).toEqual([0, 1]);
        // Along Y: x and z across the model's size (2), from the middle at 0.5, repeated twice.
        expect(projectedUv('planar', [0.5, 9, -1], space, AXIS_INDEX.y, 2)).toEqual([1.5, 0]);
        // Height along the axis makes no difference.
        expect(projectedUv('planar', [0.5, -9, -1], space, AXIS_INDEX.y, 2)).toEqual([1.5, 0]);
    });

    it('goes round a tube along its axis and round a ball from pole to pole', () => {
        const [around, along] = projectedUv('cylindrical', [1, 0.5, 0], space, AXIS_INDEX.y, 1);
        expect(around).toBeCloseTo(0.5, 6);
        expect(along).toBeCloseTo(0.75, 6);
        // A quarter turn round the axis moves a quarter of the way round the picture.
        expect(projectedUv('cylindrical', [0, 0, 1], space, AXIS_INDEX.y, 1)[0]).toBeCloseTo(0.75, 6);
        expect(projectedUv('spherical', [0, 1, 0], space, AXIS_INDEX.y, 1)[1]).toBeCloseTo(0, 6);
        expect(projectedUv('spherical', [0, -1, 0], space, AXIS_INDEX.y, 1)[1]).toBeCloseTo(1, 6);
        expect(projectedUv('spherical', [1, 0, 0], space, AXIS_INDEX.y, 2)[1]).toBeCloseTo(1, 6);
    });

    it('mirrors a fill by folding the near half onto the far one', () => {
        const near = folded([-0.4, 0.2, 0.1], [-1, 0, 0], [0, 0, 0], AXIS_INDEX.x);
        expect(near.position).toEqual([0.4, 0.2, 0.1]);
        expect(near.normal).toEqual([1, 0, 0]);
        const far = folded([0.4, 0.2, 0.1], [1, 0, 0], [0, 0, 0], AXIS_INDEX.x);
        expect(far.position).toEqual(near.position);
        // Both halves then read the same place on the picture.
        expect(projectedUv('planar', near.position, space, AXIS_INDEX.z, 1)).toEqual(projectedUv('planar', far.position, space, AXIS_INDEX.z, 1));
        expect(folded([0.3, -2, 0], [0, -1, 0], [0, 1, 0], AXIS_INDEX.y).position).toEqual([0.3, 4, 0]);
    });
});
