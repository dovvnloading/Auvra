
import { PLAYER_BLUEPRINT, PLAYER_GRAPH } from './player';
import { ENEMY_BLUEPRINT, ENEMY_GRAPH } from './enemy';
import { Blueprint } from '../../types';

export const DEFAULT_BLUEPRINTS: Blueprint[] = [
    PLAYER_BLUEPRINT,
    ENEMY_BLUEPRINT
];

export { PLAYER_GRAPH, ENEMY_GRAPH, PLAYER_BLUEPRINT, ENEMY_BLUEPRINT };
