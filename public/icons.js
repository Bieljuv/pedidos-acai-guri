/* Conjunto de ícones SVG (Açaí do Guri)
   Injeta um sprite inline no <head> e expõe <svg class="ic"><use href="#i-x"></use></svg>.
   Sem dependência externa: funciona offline e imprime bem. */
(function () {
  var SPRITE = [
    '<svg xmlns="http://www.w3.org/2000/svg" class="icon-sprite" aria-hidden="true" focusable="false">',
    '<symbol id="i-cart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.4 9.2a2 2 0 0 0 2 1.6h7.4a2 2 0 0 0 1.9-1.5L20 8H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></symbol>',
    '<symbol id="i-instagram" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1"/></symbol>',
    '<symbol id="i-whatsapp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L4 20.5l1.6-4.4A8.4 8.4 0 1 1 21 11.5Z"/><path d="M9.4 8.8h5.2v6.4H9.4z"/><path d="M11 10.8h2"/></symbol>',
    '<symbol id="i-camera" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.4"/></symbol>',
    '<symbol id="i-arrow-left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></symbol>',
    '<symbol id="i-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12M18 6 6 18"/></symbol>',
    '<symbol id="i-scooter" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="18" r="2.5"/><circle cx="18.5" cy="18" r="2.5"/><path d="M8 18h7l2.5-7.5h2"/><path d="M14.5 10.5 12.5 6h-3"/></symbol>',
    '<symbol id="i-sliders" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/></symbol>',
    '<symbol id="i-store" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Z"/><path d="M3 9 5 4h14l2 5"/><path d="M9.5 20v-6h5v6"/></symbol>',
    '<symbol id="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></symbol>',
    '<symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></symbol>',
    '<symbol id="i-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></symbol>',
    '<symbol id="i-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></symbol>',
    '<symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></symbol>',
    '<symbol id="i-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 10v4"/><circle cx="12" cy="17.4" r=".7"/></symbol>',
    '<symbol id="i-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.5 2.7 5.6 6.1.8-4.5 4.2 1.2 6-5.5-3-5.5 3 1.2-6L3.2 9.9l6.1-.8L12 3.5Z"/></symbol>',
    '<symbol id="i-wallet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2"/><path d="M3 8v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M20 13h-4a2 2 0 0 0 0 4h4"/></symbol>',
    '<symbol id="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></symbol>',
    '<symbol id="i-tag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.4V4.6a1 1 0 0 1 1-1h6.8a2 2 0 0 1 1.4.6l7.3 7.3a2 2 0 0 1 0 2.8l-5.9 5.9a2 2 0 0 1-2.8 0L4.1 12.8a2 2 0 0 1-.6-1.4Z"/><circle cx="7.8" cy="7.8" r="1.3"/></symbol>',
    '<symbol id="i-x-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></symbol>',
    '<symbol id="i-undo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h9a5 5 0 0 1 0 10h-3"/><path d="m4 9 4-4M4 9l4 4"/></symbol>',
    '<symbol id="i-bowl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11h17c0 4.4-3.8 7.5-8.5 7.5S3.5 15.4 3.5 11Z"/><circle cx="9.5" cy="8.6" r="1.9"/><circle cx="14.6" cy="8.6" r="1.9"/><path d="M12 4.2v1.4"/></symbol>',
    '<symbol id="i-receipt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-1.5L12 21l-3-1.5L6 21V3Z"/><path d="M9 8h6M9 12h6"/></symbol>',
    '<symbol id="i-grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></symbol>',
    '<symbol id="i-truck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h10v9H3z"/><path d="M13 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/></symbol>',
    '<symbol id="i-card" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19"/></symbol>',
    '<symbol id="i-chart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4M12.5 16V8M17 16v-6"/></symbol>',
    '<symbol id="i-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></symbol>',
    '<symbol id="i-user" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></symbol>',
    '<symbol id="i-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/></symbol>',
    '<symbol id="i-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 17V11a6 6 0 1 1 12 0v6"/><path d="M4 17h16"/><path d="M10 20a2 2 0 0 0 4 0"/></symbol>',
    '<symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></symbol>',
    '<symbol id="i-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></symbol>',
    '<symbol id="i-trophy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5v1.5A3 3 0 0 0 8 10.5M16 6h3v1.5A3 3 0 0 1 16 10.5"/><path d="M12 13v3M9 20h6M10 16h4"/></symbol>',
    '<symbol id="i-calculator" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><rect x="7" y="6" width="10" height="3" rx="1"/><path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/></symbol>',
    '<symbol id="i-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2 2 0 0 1 6 4h13v16H6a2 2 0 0 1-2-1.5V5.5Z"/><path d="M4 18.5A2 2 0 0 1 6 17h13"/></symbol>',
    '<symbol id="i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10.5 13.5"/><path d="M21 3 14 21l-3.5-7.5L3 10l18-7Z"/></symbol>',
    '<symbol id="i-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-2 2-2-2-2 2"/></symbol>',
    '<symbol id="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></symbol>',
    '<symbol id="i-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16"/><path d="M9.5 6.2A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.4 4M6.6 8A17 17 0 0 0 2.5 12S6 18 12 18a9 9 0 0 0 3.4-.7"/></symbol>',
    '<symbol id="i-flag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/></symbol>',
    '<symbol id="i-chef" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20h10v-3H7v3Z"/><path d="M7 17a4 4 0 0 1-1-7.9A4.2 4.2 0 0 1 12 4a4.2 4.2 0 0 1 6 5.1A4 4 0 0 1 17 17"/></symbol>',
    '<symbol id="i-print" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/></symbol>',
    '<symbol id="i-cash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/></symbol>',
    '<symbol id="i-pause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></symbol>',
    '<symbol id="i-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16 9"/></symbol>',
    '<symbol id="i-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></symbol>',
    '<symbol id="i-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7.5-4.7-7.5-9.5A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.5C19.5 15.3 12 20 12 20Z"/></symbol>',
    '<symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="m14 6 4 4"/></symbol>',
    '<symbol id="i-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5 18 12 8 18.5V5.5Z"/></symbol>',
    '<symbol id="i-arrow-up-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></symbol>',
    '<symbol id="i-arrow-down-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10"/><path d="M17 9v8H9"/></symbol>',
    '<symbol id="i-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5v-7Z"/><path d="M3 8.5 12 13l9-4.5M12 13v7"/></symbol>',
    '<symbol id="i-hourglass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10M7 21h10"/><path d="M8 3v3.5c0 2 4 3.8 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 3.8-4 5.5s4 3.5 4 5.5V21"/></symbol>',
    '<symbol id="i-wand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 15 9"/><path d="m14 4 1 2.2L17 7.2 15 8.4 14 10.6 13 8.4 11 7.2l2-1z"/><path d="M19 13l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/></symbol>',
    '<symbol id="i-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3.6 13.2L12 17.7l8.4-4.5"/></symbol>',
    '<symbol id="i-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.2" r="3.2"/><path d="M3.6 19.6c.6-3.1 2.7-4.7 5.4-4.7s4.8 1.6 5.4 4.7"/><path d="M15.4 5.5a3.2 3.2 0 0 1 0 5.7M17.9 15.4c1.4.7 2.3 2 2.6 4.2"/></symbol>',
    '<symbol id="i-check-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.3 12.4l2.5 2.5 4.7-5.6"/></symbol>',
    '<symbol id="i-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></symbol>',
    '<symbol id="i-chevron-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></symbol>',
    '<symbol id="i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h3.5A1.5 1.5 0 0 1 19 5.5v13A1.5 1.5 0 0 1 17.5 20H14"/><path d="M3.5 12h11M10.5 7.5L15 12l-4.5 4.5"/></symbol>',
    '<symbol id="i-play-fill" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z"/></symbol>',
    '</svg>'
  ].join('');

  function injetar() {
    if (document.getElementById('icon-sprite')) return;
    var holder = document.createElement('div');
    holder.innerHTML = SPRITE;
    var svg = holder.firstChild;
    if (svg && document.head) document.head.appendChild(svg);
  }

  if (document.head) injetar();
  else document.addEventListener('DOMContentLoaded', injetar);

  // helper global: ic('cart') -> <svg class="ic"><use href="#i-cart"></use></svg>
  window.ic = function (nome, extra) {
    var cls = 'ic' + (extra ? ' ' + extra : '');
    return '<svg class="' + cls + '" aria-hidden="true" focusable="false"><use href="#i-' + nome + '"></use></svg>';
  };
  // Alias interno: paginas que ja tem um helper local chamado ic() (declaracao
  // de funcao no script da pagina sobrescreve window.ic) chamam por aqui.
  window.icSprite = window.ic;
})();
