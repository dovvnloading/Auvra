import { describe, expect, it } from 'vitest';
import { COMPONENT_DEFINITIONS, createComponent, getComponentDefinition } from '../../runtime/components/registry';

describe('component registry', () => {
  it('registers the built-in components once each, with a renderer and editable props', () => {
    const types = COMPONENT_DEFINITIONS.map(definition => definition.type);
    expect(types).toEqual(['rotator', 'mover', 'pointLight', 'spotLight']);
    for (const definition of COMPONENT_DEFINITIONS) {
      expect(getComponentDefinition(definition.type)).toBe(definition);
      expect(definition.label).not.toBe('');
      expect(typeof definition.Render).toBe('function');
      const keys = definition.props.map(prop => prop.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(getComponentDefinition('missing')).toBeUndefined();
  });

  it('creates enabled components with every prop at its default', () => {
    expect(createComponent('rotator')).toMatchObject({ type: 'rotator', enabled: true, props: { axis: 'y', speed: 45 } });
    expect(createComponent('mover').props).toEqual({ offset: [0, 2, 0], period: 4, pingPong: true });
    expect(createComponent('pointLight').props).toEqual({ color: '#ffffff', intensity: 20, distance: 15, castShadow: false });
    expect(createComponent('spotLight').props).toEqual({
      color: '#ffffff', intensity: 60, distance: 20, angle: 35, penumbra: 0.3, castShadow: true,
    });
    for (const definition of COMPONENT_DEFINITIONS) {
      const component = createComponent(definition.type);
      expect(Object.keys(component.props).sort()).toEqual(definition.props.map(prop => prop.key).sort());
    }
  });

  it('gives each component its own id and its own copy of array defaults', () => {
    const first = createComponent('mover');
    const second = createComponent('mover');
    expect(first.id).not.toBe(second.id);

    (first.props.offset as number[])[1] = 9;
    expect(second.props.offset).toEqual([0, 2, 0]);
    expect(getComponentDefinition('mover')!.props.find(prop => prop.key === 'offset')!.default).toEqual([0, 2, 0]);
  });

  it('keeps select defaults within their options and numeric defaults within their range', () => {
    for (const definition of COMPONENT_DEFINITIONS) {
      for (const prop of definition.props) {
        if (prop.type === 'select') expect(prop.options?.map(option => option.value)).toContain(prop.default);
        if (prop.type === 'number') {
          expect(typeof prop.default).toBe('number');
          if (prop.min !== undefined) expect(prop.default as number).toBeGreaterThanOrEqual(prop.min);
          if (prop.max !== undefined) expect(prop.default as number).toBeLessThanOrEqual(prop.max);
        }
      }
    }
  });

  it('rejects unknown component types', () => {
    expect(() => createComponent('teleporter')).toThrow(/Unknown component type "teleporter"/);
  });
});
