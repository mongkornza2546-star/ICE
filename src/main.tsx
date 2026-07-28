import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LocalDemoApp } from './LocalDemoApp';
import { env } from './lib/env';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {env.isDemoMode ? <LocalDemoApp /> : <App />}
    <PwaUpdatePrompt />
  </React.StrictMode>,
);
