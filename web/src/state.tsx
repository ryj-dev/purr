import { createContext, useContext } from 'react';
import type { AppState } from '../../src/shared/types.ts';
import type { BlockTypeInfo } from './api.ts';

export interface AppCtx {
  state: AppState | null;
  blockTypes: BlockTypeInfo[];
  refresh: () => Promise<void>;
  connected: boolean;
}

export const AppContext = createContext<AppCtx>({ state: null, blockTypes: [], refresh: async () => {}, connected: false });
export const useApp = () => useContext(AppContext);
