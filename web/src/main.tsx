import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/overpass';
import '@fontsource/overpass-mono/400.css';
import '@fontsource/overpass-mono/600.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Inside PuRR.app: native title bar spacing and window drag regions (see styles.css `.desktop`).
if (window.purrDesktop) document.documentElement.classList.add('desktop');
