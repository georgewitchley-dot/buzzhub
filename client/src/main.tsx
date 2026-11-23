import { InvoicePage, WalletPage } from './pages/Club';
import { LinkHub } from './pages/Reach';
import { EventsPage, LobbyScreen, TicketPage } from './pages/House';
import { CustomerDisplay } from './pages/Plus';
import { CateringOrder } from './pages/Smart';
import { TimeClockScreen } from './pages/Clock';
import { PublicAllergens, RateCatering } from './pages/Desk';
import { KdsScreen, MenuBoard } from './pages/Areas';
import { PrintAgentPage } from './pages/Devices';
import { PublicRooms, RoomBooking } from './pages/Crew';
import PayPage from './pages/PayPage';
import Receipt from './pages/Receipt';
import Kiosk from './pages/Kiosk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';
import { ApprovalHost, ToastProvider } from './ui';
import CommandCenter from './pages/CommandCenter';
import Guest from './pages/Guest';
import Join from './pages/Join';
import Account from './pages/Account';
import { RateVisit } from './pages/Feedback';
import PayPhone from './pages/PayPhone';
import { GiftPage, OrderOnline, TableOrder } from './pages/OrderOnline';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <ApprovalHost />
      <BrowserRouter>
        <Routes>
          <Route path="/b/:token" element={<Guest />} />
          <Route path="/join" element={<Join />} />
          <Route path="/account" element={<Account />} />
          <Route path="/f/:token" element={<RateVisit />} />
          <Route path="/p/:token" element={<PayPhone />} />
          <Route path="/order" element={<OrderOnline />} />
          <Route path="/t/:token" element={<TableOrder />} />
          <Route path="/gift" element={<GiftPage />} />
          <Route path="/pay/:token" element={<PayPage />} />
          <Route path="/r/:token" element={<Receipt />} />
          <Route path="/kiosk" element={<Kiosk />} />
          <Route path="/i/:token" element={<InvoicePage />} />
          <Route path="/w/:token" element={<WalletPage />} />
          <Route path="/go" element={<LinkHub />} />
          <Route path="/screen" element={<LobbyScreen />} />
          <Route path="/display" element={<CustomerDisplay />} />
          <Route path="/catering-order" element={<CateringOrder />} />
          <Route path="/timeclock" element={<TimeClockScreen />} />
          <Route path="/allergens" element={<PublicAllergens />} />
          <Route path="/rate/:token" element={<RateCatering />} />
          <Route path="/kds" element={<KdsScreen />} />
          <Route path="/print-agent" element={<PrintAgentPage />} />
          <Route path="/menuboard" element={<MenuBoard />} />
          <Route path="/event-rooms" element={<PublicRooms />} />
          <Route path="/event-room/:token" element={<RoomBooking />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/ticket/:code" element={<TicketPage />} />
          <Route path="/*" element={<CommandCenter />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
