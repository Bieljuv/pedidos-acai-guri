'use strict';
// Projeto ORIGINAL — loja ÚNICA. Os módulos portados da linha SaaS
// (ifood, equipe) leem a "loja ativa" daqui: aqui ela é sempre a 1,
// sem resolução por subdomínio/domínio e sem troca de contexto.
module.exports = {
  lojaId: () => 1,
  definir: () => {},
  como: async (lojaId, fn) => fn(),
};
