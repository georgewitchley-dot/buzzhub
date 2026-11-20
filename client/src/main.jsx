import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';
import { ToastProvider } from './ui.jsx';
import CommandCenter from './pages/CommandCenter.jsx';
import Guest from './pages/Guest.jsx';
import Join from './pages/Join.jsx';
import Account from './pages/Account.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/b/:token" element={<Guest />} />
          <Route path="/join" element={<Join />} />
          <Route path="/account" element={<Account />} />
          <Route path="/*" element={<CommandCenter />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
