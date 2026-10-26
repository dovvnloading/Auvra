import React, { createContext, useContext } from 'react';
import type { GameContent } from './types';

const EMPTY_CONTENT: GameContent = {
    models: [], blueprints: [], attachments: [], sockets: [], textures: [], audioAssets: [],
};

const GameContentContext = createContext<GameContent>(EMPTY_CONTENT);

/** Supplies loaded content to gameplay code. The editor feeds it from its contexts; the player from a game pack. */
export const GameContentProvider: React.FC<{ value: GameContent; children: React.ReactNode }> = ({ value, children }) => (
    <GameContentContext.Provider value={value}>{children}</GameContentContext.Provider>
);

export const useGameContent = (): GameContent => useContext(GameContentContext);
