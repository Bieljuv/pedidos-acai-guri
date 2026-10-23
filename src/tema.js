'use strict';
// Tema do sistema (v1.9.29): o dono escolhe 2 cores (principal e
// destaque) e o sistema deriva a paleta inteira — hover, tons escuros
// da barra lateral, fundo suave e o tom claro que aparece no modo
// escuro. Sem as cores salvas, a paleta é EXATAMENTE a original
// (roxo do Açaí do Guri) — instalar a versão não muda nada visual.

const PADRAO = { primaria: '#7E047D', destaque: '#DB04E2' };

function hexParaHsl(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}
function hslParaHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const v = (w) => Math.round((w + m) * 255).toString(16).padStart(2, '0');
  return ('#' + v(r) + v(g) + v(b)).toUpperCase();
}
const validaHex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());

// A paleta ORIGINAL, intocada: enquanto o dono não salvar cor nenhuma,
// é ela que vale (byte a byte a de hoje) — personalizar é que liga a
// derivação automática.
const PALETA_ORIGINAL = {
  '--primary': '#7E047D', '--primary-hover': '#66036A', '--accent': '#DB04E2',
  '--violet': '#902A88', '--deep': '#3C0151', '--night': '#22002E',
  '--bg': '#FBF7FD', '--ink': '#2A0530', '--destaque-claro': '#F2C1F7',
  '--linha': '#EBDCEF',
};

// Deriva a paleta completa a partir das 2 cores base.
function paleta(primaria, destaque) {
  if (!validaHex(primaria) && !validaHex(destaque)) return { ...PALETA_ORIGINAL };
  const p = hexParaHsl(validaHex(primaria) ? primaria : PADRAO.primaria) || hexParaHsl(PADRAO.primaria);
  const a = hexParaHsl(validaHex(destaque) ? destaque : PADRAO.destaque) || hexParaHsl(PADRAO.destaque);
  const P = (h, s, l) => hslParaHex(h, s, l);
  return {
    '--primary': P(p.h, p.s, p.l),
    '--primary-hover': P(p.h, Math.min(100, p.s + 2), Math.max(4, p.l - 7)),
    '--accent': P(a.h, a.s, a.l),
    '--violet': P((p.h + a.h) / 2, (p.s + a.s) / 2, Math.min(52, (p.l + a.l) / 2 + 8)),
    '--deep': P(p.h, Math.min(100, p.s + 3), Math.max(5, p.l * 0.6)),
    '--night': P(p.h, Math.min(100, p.s + 3), Math.max(3, p.l * 0.36)),
    '--bg': P(p.h, Math.min(70, p.s * 0.7 + 18), 98),
    '--ink': P(p.h, Math.min(60, p.s * 0.6), 10),
    '--destaque-claro': P(a.h, Math.min(100, a.s), a.l + (100 - a.l) * 0.72),
    '--linha': P(p.h, Math.min(45, p.s * 0.45), 90),
  };
}
function cssDoTema(primaria, destaque) {
  const vars = paleta(primaria, destaque);
  const corpo = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `:root{\n${corpo}\n}\n`;
}

module.exports = { PADRAO, paleta, cssDoTema, validaHex };
