import { FABRIC_FIELDS, type GarmentFabricOverrides } from './fitting';

export const SWATCH_HEADER = 'test,width_mm,gauge_mm,displacement_mm,force_n,mass_g';
export const SWATCH_LIMITS = { characters: 65536, rows: 512 };
export type SwatchTest = 'mass' | 'warp' | 'weft' | 'shear';
export type SwatchCoefficient = 'arealDensity' | 'warp' | 'weft' | 'shear';

export interface SwatchReading {
    kind: SwatchTest;
    width: number; // m
    gauge: number; // m
    displacement: number; // m
    force: number; // N
    mass: number; // kg
}
export interface SwatchFit {
    field: SwatchCoefficient;
    coefficient: number;
    count: number;
    rms: number; // N for mechanics, g for weighing
    maximum: number;
    residualUnit: 'N' | 'g';
}
export interface SwatchCalibration {
    fits: SwatchFit[];
    properties: GarmentFabricOverrides;
    shearWeftSource?: 'measured' | 'current';
}

function readingNumber(raw: string, line: number, field: string): number {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw)))
        throw new Error('Line ' + line + ' needs a finite number for ' + field + '.');
    return Number(raw);
}

/** Plain numeric CSV or tab-separated spreadsheet rows. Dimension columns use unloaded dimensions. */
export function readSwatchMeasurements(text: string): SwatchReading[] {
    if (text.length > SWATCH_LIMITS.characters) throw new Error('The swatch data exceeds 64 KiB of text.');
    const lines = text.split(/\r\n?|\n/);
    const header = lines.findIndex(line => line.trim());
    if (header < 0) throw new Error('Enter the header and at least one swatch measurement.');
    const separator = lines[header].includes('\t') ? '\t' : ',';
    const cells = (line: string) => line.split(separator).map(x => x.trim().toLowerCase());
    if (cells(lines[header]).join(',') !== SWATCH_HEADER) throw new Error('Use the header ' + SWATCH_HEADER + '.');
    const rows: SwatchReading[] = [];
    for (let i = header + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        if (rows.length >= SWATCH_LIMITS.rows) throw new Error('Use at most 512 swatch measurements.');
        const line = i + 1;
        const row = cells(lines[i]);
        const [kind, width, gauge, displacement, force, mass] = row;
        if (row.length !== 6 || !(kind === 'mass' || kind === 'warp' || kind === 'weft' || kind === 'shear'))
            throw new Error('Line ' + line + ' needs six columns and a mass, warp, weft or shear test.');
        const w = readingNumber(width, line, 'width_mm') / 1000;
        const l = readingNumber(gauge, line, 'gauge_mm') / 1000;
        if (!(w > 0 && l > 0)) throw new Error('Line ' + line + ' needs positive unloaded dimensions.');
        const reading: SwatchReading = { kind, width: w, gauge: l, displacement: 0, force: 0, mass: 0 };
        if (kind === 'mass') {
            reading.mass = readingNumber(mass, line, 'mass_g') / 1000;
            if (reading.mass <= 0 || displacement || force) throw new Error('Line ' + line + ' needs a positive mass and empty displacement and force columns.');
        } else {
            reading.displacement = readingNumber(displacement, line, 'displacement_mm') / 1000;
            reading.force = readingNumber(force, line, 'force_n');
            if (mass || (kind !== 'shear' && reading.displacement < 0))
                throw new Error('Line ' + line + ' needs an empty mass column and tensile or signed shear displacement.');
        }
        rows.push(reading);
    }
    if (!rows.length) throw new Error('Enter at least one swatch measurement.');
    return rows;
}

/**
 * Minimize squared force (or mass) residuals through the physical unloaded origin.
 * For uniaxial extension the solver's Green strain is E = (lambda² - 1)/2.
 * In simple shear F = [[1,gamma],[0,1]], its weft stretch also stores energy.
 * Differentiating both energy terms gives P12 = G gamma + Kweft gamma³/2.
 */
export function calibrateSwatches(text: string, currentWeft: number): SwatchCalibration {
    const rows = readSwatchMeasurements(text);
    const result: SwatchCalibration = { fits: [], properties: {} };
    for (const kind of ['mass', 'warp', 'weft', 'shear'] as const) {
        const observations = rows.filter(r => r.kind === kind);
        if (!observations.length) continue;
        const field = kind === 'mass' ? 'arealDensity' : kind;
        const weft = result.properties.weft ?? currentWeft;
        if (kind === 'shear') {
            if (!Number.isFinite(weft) || weft < 0) throw new Error('Simple shear needs a finite weft stiffness.');
            result.shearWeftSource = result.properties.weft === undefined ? 'current' : 'measured';
        }
        const pairs = observations.map(r => {
            if (kind === 'mass') return { x: r.width * r.gauge, y: r.mass };
            const e = r.displacement / r.gauge;
            if (kind === 'shear') return { x: r.width * e, y: r.force - r.width * weft * e ** 3 / 2 };
            return { x: r.width * (1 + e) * e * (1 + e / 2), y: r.force };
        });
        let xx = 0, xy = 0;
        for (const { x, y } of pairs) { xx += x * x; xy += x * y; }
        if (!(xx > 0 && Number.isFinite(xx))) throw new Error('The ' + kind + ' readings need a usable nonzero area or displacement.');
        const coefficient = xy / xx, limits = FABRIC_FIELDS[field];
        if (!Number.isFinite(coefficient) || coefficient < limits.min || coefficient > limits.max)
            throw new Error('The fitted ' + kind + ' coefficient is outside the supported range. Check units, tare and load direction.');
        let squared = 0, maximum = 0;
        for (const { x, y } of pairs) {
            const error = (coefficient * x - y) * (kind === 'mass' ? 1000 : 1);
            squared += error * error;
            maximum = Math.max(maximum, Math.abs(error));
        }
        if (!Number.isFinite(squared)) throw new Error('Swatch residuals overflowed. Check measurement units.');
        result.properties[field] = coefficient;
        result.fits.push({ field, coefficient, count: pairs.length, rms: Math.sqrt(squared / pairs.length),
            maximum, residualUnit: kind === 'mass' ? 'g' : 'N' });
    }
    return result;
}
