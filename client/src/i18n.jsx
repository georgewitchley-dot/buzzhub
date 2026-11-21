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
  // online ordering, invoices, link hub, chat
  'Our menu': 'Nuestro menú', 'Online ordering is closed': 'Los pedidos en línea están cerrados', 'Please call or visit {name}.': 'Llame o visite {name}.',
  'Start an order': 'Hacer un pedido', 'Order from {name}': 'Pedir en {name}', 'Review order: {n} items, {total}': 'Revisar pedido: {n} productos, {total}', 'Add more': 'Agregar más',
  'For': 'Para', 'Event': 'Evento', 'Due': 'Vence', 'Fee': 'Cargo', 'Paid': 'Pagado', 'Balance': 'Saldo', 'Accepted by': 'Aceptado por',
  'This quote was cancelled.': 'Esta cotización fue cancelada.', 'Paid in full. Thank you!': 'Pagado por completo. ¡Gracias!', 'Accept this quote': 'Aceptar esta cotización',
  'Your full name': 'Su nombre completo', 'I accept': 'Acepto', 'Pay deposit': 'Pagar depósito', 'Pay the full balance': 'Pagar el saldo completo',
  'We will be in touch about payment.': 'Nos comunicaremos con usted sobre el pago.', 'Print or save as PDF': 'Imprimir o guardar como PDF',
  'Join the waitlist': 'Unirse a la lista de espera', 'Get in line': 'Hacer fila', 'Book a table': 'Reservar una mesa', 'Book an appointment': 'Reservar una cita',
  'Order pickup or delivery': 'Pedir para recoger o a domicilio', 'Order delivery': 'Pedir a domicilio', 'Order for pickup': 'Pedir para recoger', 'See the menu': 'Ver el menú',
  'Memberships': 'Membresías', 'Buy a gift card': 'Comprar tarjeta de regalo', 'Leave us a review': 'Déjenos una reseña', 'Directions': 'Cómo llegar',
  'Message us': 'Envíenos un mensaje', 'Messages': 'Mensajes', 'Type a message': 'Escriba un mensaje', 'Send': 'Enviar',
  'Ask us anything: a high chair, a change to your order, running late.': 'Pregúntenos lo que sea: silla para bebé, un cambio en su pedido, si va tarde.',
  // buzzer
  'Your order is ready': 'Su pedido está listo', 'Your {unit} is ready': 'Su {unit} está lista', 'See you in a moment': 'Nos vemos en un momento',
  "We've let the team know you're on the way.": 'Avisamos al equipo que va en camino.', 'Thanks {name}, your order is in': 'Gracias {name}, recibimos su pedido',
  'Almost your turn': 'Ya casi es su turno', "Hi {name}, you're on the list": 'Hola {name}, está en la lista',
  "Order #{n} is being made. We'll buzz your phone when it's ready.": 'Estamos preparando el pedido #{n}. Le avisaremos en su teléfono cuando esté listo.',
  'Please stay close. We will buzz you any minute.': 'Quédese cerca. Le avisaremos en cualquier momento.', "You're next": 'Usted sigue', 'in line': 'en la fila',
  'Enjoy!': '¡Que lo disfrute!', "You're off the list": 'Ya no está en la lista', "I'm on my way": 'Voy en camino', 'Turn on alerts': 'Activar avisos',
  'On its way': 'En camino', 'About {n} minutes away': 'A unos {n} minutos', 'Your driver': 'Su repartidor',
  'is bringing your order': 'lleva su pedido', 'Delivered. Enjoy!': 'Entregado. ¡Buen provecho!',
  'Goes great with': 'Va muy bien con', "Today's specials": 'Especiales de hoy', 'Events at {name}': 'Eventos en {name}', 'No upcoming events right now. Check back soon!': 'No hay eventos próximos. ¡Vuelva pronto!',
  'Free': 'Gratis', '{n} seats left': 'Quedan {n} lugares', 'Sold out': 'Agotado', 'Your name': 'Su nombre', 'Tickets': 'Entradas', 'Get my tickets': 'Obtener mis entradas',
  'Get tickets': 'Comprar entradas', 'Save my seat': 'Reservar mi lugar', '{n} tickets': '{n} entradas', 'Confirming your payment…': 'Confirmando su pago…', 'Checked in: {n}': 'Registrados: {n}', 'Show this at the door': 'Muestre esto en la entrada',
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
