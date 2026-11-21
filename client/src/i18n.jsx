import { useState } from 'react';

// Customer-facing text in English and Spanish. Staff screens stay in English.
const ES = {
  'Pay': 'Pagar', 'Total': 'Total', 'Tip': 'Propina', 'Subtotal': 'Subtotal', 'Tax': 'Impuesto',
  'How would you like to pay?': '¿Cómo le gustaría pagar?', 'No fees for us': 'Sin comisiones para nosotros',
  'Lowest fee': 'Comisión más baja', 'Card, Apple Pay, Google Pay, Cash App Pay or Afterpay': 'Tarjeta, Apple Pay, Google Pay, Cash App Pay o Afterpay',
  'Card, Apple Pay or Google Pay': 'Tarjeta, Apple Pay o Google Pay', 'Pay by card': 'Pagar con tarjeta',
  'Open {app}': 'Abrir {app}', 'Send {amount} to {handle}': 'Envíe {amount} a {handle}', "I've sent it": 'Ya lo envié',
  'Your name as it shows in the app': 'Su nombre como aparece en la app', 'Copy': 'Copiar', 'Copied': 'Copiado',
  'Send with Zelle from your bank app to': 'Envíe con Zelle desde la app de su banco a',
  "Thanks! We're checking your payment": '¡Gracias! Estamos confirmando su pago',
  'This page updates on its own as soon as the team confirms it.': 'Esta página se actualiza sola en cuanto el equipo lo confirme.',
  'Paid. Thank you!': 'Pagado. ¡Gracias!', 'Back': 'Volver', 'Confirming your payment…': 'Confirmando su pago…',
  'This payment link is not valid.': 'Este enlace de pago no es válido.',
  'Choose another way to pay': 'Elegir otra forma de pago',
  // kiosk
  'Tap to start your order': 'Toque para empezar su pedido', 'Your order': 'Su pedido', 'Add': 'Agregar', 'Remove': 'Quitar',
  'Eat here': 'Para comer aquí', 'To go': 'Para llevar', 'Your name': 'Su nombre', 'Pay at the counter': 'Pagar en el mostrador',
  'Pay with card here': 'Pagar con tarjeta aquí', 'Place order': 'Hacer pedido', 'Start over': 'Empezar de nuevo',
  'Your number': 'Su número', 'Scan to get a buzz on your phone when it’s ready': 'Escanee para recibir un aviso en su teléfono cuando esté listo',
  'Pay at the counter when you pick it up.': 'Pague en el mostrador al recogerlo.', 'Paid. Thank you!!': '¡Pagado! Gracias.',
  'Tap, insert or swipe your card on the reader': 'Acerque, inserte o deslice su tarjeta en el lector', 'Done': 'Listo',
  'Promo code': 'Código de promoción', 'Nothing here yet. Tap an item to add it.': 'Aún no hay nada. Toque un producto para agregarlo.',
  'Options': 'Opciones', 'Add {n} for {price}': 'Agregar {n} por {price}', 'Note for the kitchen (optional)': 'Nota para la cocina (opcional)',
  // buzzer
  'Your order is ready': 'Su pedido está listo', 'Your {unit} is ready': 'Su {unit} está lista', 'See you in a moment': 'Nos vemos en un momento',
  "We've let the team know you're on the way.": 'Avisamos al equipo que va en camino.', 'Thanks {name}, your order is in': 'Gracias {name}, recibimos su pedido',
  'Almost your turn': 'Ya casi es su turno', "Hi {name}, you're on the list": 'Hola {name}, está en la lista',
  "Order #{n} is being made. We'll buzz your phone when it's ready.": 'Estamos preparando el pedido #{n}. Le avisaremos en su teléfono cuando esté listo.',
  'Please stay close. We will buzz you any minute.': 'Quédese cerca. Le avisaremos en cualquier momento.', "You're next": 'Usted sigue', 'in line': 'en la fila',
  'Enjoy!': '¡Que lo disfrute!', "You're off the list": 'Ya no está en la lista', "I'm on my way": 'Voy en camino', 'Turn on alerts': 'Activar avisos',
  'On its way': 'En camino', 'About {n} minutes away': 'A unos {n} minutos', 'Your driver': 'Su repartidor',
  'is bringing your order': 'lleva su pedido', 'Delivered. Enjoy!': 'Entregado. ¡Buen provecho!',
};
const DICTS = { es: ES };

export function getLang() {
  try { const saved = localStorage.getItem('bh_lang'); if (saved) return saved; } catch { /* private mode */ }
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}
export function tr(lang, key, vars) {
  let s = DICTS[lang]?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
export function useLang() {
  const [lang, setLangState] = useState(getLang);
  const setLang = (l) => { try { localStorage.setItem('bh_lang', l); } catch { /* private mode */ } setLangState(l); document.documentElement.lang = l; };
  return { lang, setLang, t: (k, v) => tr(lang, k, v) };
}
export function LangSwitch({ lang, setLang }) {
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      <button aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
      <button aria-pressed={lang === 'es'} onClick={() => setLang('es')}>Español</button>
    </div>
  );
}
