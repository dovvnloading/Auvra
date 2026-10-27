const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Where a spawner's `index`-th spawn appears: the first on the spawner, later ones on a widening
 * spiral around it, so enemies that spawn while earlier ones still stand there do not stack into one.
 */
export const spawnPositionAround = (base: readonly [number, number, number], index: number): [number, number, number] => {
    if (index <= 0) return [base[0], base[1], base[2]];
    const angle = index * GOLDEN_ANGLE;
    const radius = 1.5 * Math.sqrt(index);
    return [base[0] + Math.cos(angle) * radius, base[1], base[2] + Math.sin(angle) * radius];
};
