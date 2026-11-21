import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** Live map of the driver heading to the customer. */
export function DeliveryMap({ driver, drop }) {
  const el = useRef(null); const map = useRef(null); const marks = useRef({});
  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([driver.lat, driver.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
    return () => { map.current?.remove(); map.current = null; marks.current = {}; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = map.current; if (!m) return;
    const icon = (cls) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    if (!marks.current.d) marks.current.d = L.marker([driver.lat, driver.lng], { icon: icon('drv-pin') }).addTo(m); else marks.current.d.setLatLng([driver.lat, driver.lng]);
    if (drop) { if (!marks.current.h) marks.current.h = L.marker([drop.lat, drop.lng], { icon: icon('home-pin') }).addTo(m); m.fitBounds(L.latLngBounds([[driver.lat, driver.lng], [drop.lat, drop.lng]]).pad(0.35), { animate: true }); }
    else m.panTo([driver.lat, driver.lng]);
  }, [driver.lat, driver.lng, drop?.lat, drop?.lng]);
  return <div className="dlv-map" ref={el} role="img" aria-label="Map showing your driver" />;
}
