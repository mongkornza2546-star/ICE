import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import { LocalDemoApp } from './LocalDemoApp';
import { env } from './lib/env';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import { ThermalPrinterSetup } from './ThermalPrinterSetup';
import { shouldUsePwaExperience } from './pwaUpdateSafety';
import './index.css';

const usePwaExperience = shouldUsePwaExperience(Capacitor.isNativePlatform());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {env.isDemoMode ? <LocalDemoApp /> : <App />}
    {usePwaExperience ? <PwaUpdatePrompt /> : null}
    <ThermalPrinterSetup />
  </React.StrictMode>,
);
