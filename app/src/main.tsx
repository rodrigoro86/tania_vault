import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { iniciarAutoUpdate } from './autoUpdate';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA: service worker só no build (em dev o Vite serve módulos soltos, sem /assets com hash)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker não registrado:', err));
  });
}

if (import.meta.env.PROD) iniciarAutoUpdate();
