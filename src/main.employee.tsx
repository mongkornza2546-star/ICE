import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThermalPrinterSetup } from './ThermalPrinterSetup';
import { LanguageProvider } from './i18n';
import './employee.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
      <ThermalPrinterSetup />
    </LanguageProvider>
  </React.StrictMode>,
);
