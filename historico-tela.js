// Desenha o histórico de preço (resumo, gráfico e tabela). Usado pela página privada (app local)
// e pela página pública (repositório historico-de-precos), que tem uma cópia deste arquivo.
(function () {
  const NOMES_FONTE = {
    arquivo: 'Cópia antiga da página (Internet Archive)',
    loja: 'Lido na loja',
    telegram: 'Anunciado no Telegram',
  };
  const NOMES_LOJA = { amazon: 'Amazon', mercadolivre: 'Mercado Livre' };

  function esc(valor) {
    return String(valor ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function reais(centavos) {
    if (centavos == null) return '—';
    return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function dataCurta(iso) {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  }

  function linkSeguro(url) {
    return /^https:\/\//.test(url || '') ? url : null;
  }

  function grafico(pontos, largura) {
    // Desenha na largura real da tela, para o texto do eixo não encolher no celular.
    const L = Math.round(Math.max(300, Math.min(900, largura || 720)));
    const A = L < 500 ? 240 : 300;
    const m = { esq: 96, dir: 12, topo: 16, base: 40 };
    const tempos = pontos.map((p) => Date.parse(p.data));
    const precos = pontos.map((p) => p.precoCentavos);
    let t0 = Math.min(...tempos);
    let t1 = Math.max(...tempos);
    if (t0 === t1) {
      t0 -= 86400000;
      t1 += 86400000;
    }
    // Escala com valores redondos (1, 2 ou 5 × 10^n reais) e 3 a 5 divisões.
    const minimo = Math.min(...precos);
    const maximo = Math.max(...precos);
    const bruto = Math.max((maximo - minimo) / 4, maximo * 0.02, 100);
    const potencia = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = [1, 2, 5, 10].map((f) => f * potencia).find((v) => v >= bruto);
    const p0 = Math.max(0, Math.floor(minimo / passo) * passo);
    let p1 = Math.ceil(maximo / passo) * passo;
    if (p1 === p0) p1 = p0 + passo;
    const divisoes = Math.round((p1 - p0) / passo);

    const x = (t) => m.esq + ((t - t0) / (t1 - t0)) * (L - m.esq - m.dir);
    const y = (p) => A - m.base - ((p - p0) / (p1 - p0)) * (A - m.topo - m.base);

    const linhasY = [];
    for (let i = 0; i <= divisoes; i++) {
      const valor = p0 + passo * i;
      linhasY.push(
        `<line x1="${m.esq}" x2="${L - m.dir}" y1="${y(valor)}" y2="${y(valor)}" class="hp-grade"/>` +
          `<text x="${m.esq - 8}" y="${y(valor) + 4}" text-anchor="end" class="hp-eixo">${esc(reais(valor))}</text>`,
      );
    }
    const marcasX = [];
    const nDatas = L < 500 ? 1 : 3;
    for (let i = 0; i <= nDatas; i++) {
      const t = t0 + ((t1 - t0) * i) / nDatas;
      marcasX.push(
        `<text x="${x(t)}" y="${A - m.base + 22}" text-anchor="${i === 0 ? 'start' : i === nDatas ? 'end' : 'middle'}" class="hp-eixo">${esc(dataCurta(new Date(t).toISOString()))}</text>`,
      );
    }

    const caminho = pontos.map((p, i) => `${i ? 'L' : 'M'}${x(tempos[i]).toFixed(1)},${y(p.precoCentavos).toFixed(1)}`).join(' ');
    const bolinhas = pontos
      .map(
        (p, i) =>
          `<circle cx="${x(tempos[i]).toFixed(1)}" cy="${y(p.precoCentavos).toFixed(1)}" r="5" class="hp-ponto hp-${esc(p.fonte)}">` +
          `<title>${esc(dataCurta(p.data))}: ${esc(reais(p.precoCentavos))} (${esc(NOMES_FONTE[p.fonte] || p.fonte)})</title></circle>`,
      )
      .join('');

    const menor = pontos.reduce((a, b) => (b.precoCentavos < a.precoCentavos ? b : a));
    const maior = pontos.reduce((a, b) => (b.precoCentavos > a.precoCentavos ? b : a));
    const descricao = `Gráfico do preço de ${dataCurta(pontos[0].data)} a ${dataCurta(pontos[pontos.length - 1].data)}: menor ${reais(menor.precoCentavos)}, maior ${reais(maior.precoCentavos)}, último ${reais(pontos[pontos.length - 1].precoCentavos)}. Os valores estão na tabela abaixo.`;

    return `<svg viewBox="0 0 ${L} ${A}" class="hp-svg" role="img" aria-label="${esc(descricao)}">
      ${linhasY.join('')}${marcasX.join('')}
      <path d="${caminho}" class="hp-linha"/>
      ${bolinhas}
    </svg>`;
  }

  function legenda(pontos) {
    const fontes = [...new Set(pontos.map((p) => p.fonte))];
    return `<ul class="hp-legenda">${fontes
      .map((f) => `<li><span class="hp-marca hp-${esc(f)}" aria-hidden="true"></span>${esc(NOMES_FONTE[f] || f)}</li>`)
      .join('')}</ul>`;
  }

  function tabela(pontos) {
    const linhas = [...pontos]
      .reverse()
      .map((p) => {
        const link = linkSeguro(p.link);
        const origem = link
          ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(NOMES_FONTE[p.fonte] || p.fonte)}<span class="hp-sr"> (abre em nova aba)</span></a>`
          : esc(NOMES_FONTE[p.fonte] || p.fonte);
        return `<tr><td>${esc(dataCurta(p.data))}</td><td>${esc(reais(p.precoCentavos))}</td><td>${p.precoDeCentavos ? esc(reais(p.precoDeCentavos)) : '—'}</td><td>${origem}</td></tr>`;
      })
      .join('');
    return `<details class="hp-detalhes"><summary>Ver todos os ${pontos.length} registros</summary>
      <div class="hp-rolagem"><table class="hp-tabela">
        <caption class="hp-sr">Preços registrados, do mais novo ao mais antigo</caption>
        <thead><tr><th scope="col">Data</th><th scope="col">Preço</th><th scope="col">Preço "de"</th><th scope="col">Fonte</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div></details>`;
  }

  /** dados: { produto: {loja, id, url}, titulo, pontos, resumo, avisos? } */
  function desenhar(container, dados) {
    const { produto, resumo } = dados;
    const pontos = [...(dados.pontos || [])].sort((a, b) => a.data.localeCompare(b.data));
    const url = linkSeguro(produto.url);
    const titulo = dados.titulo || `${NOMES_LOJA[produto.loja] || produto.loja} ${produto.id}`;
    const avisos = (dados.avisos || []).map((a) => `<li>${esc(a)}</li>`).join('');

    const cartoes = resumo && resumo.quantidade
      ? `<dl class="hp-cartoes">
          <div><dt>Último preço</dt><dd>${esc(reais(resumo.atual.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.atual.data))}</dd></div>
          <div><dt>Menor</dt><dd>${esc(reais(resumo.menor.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.menor.data))}</dd></div>
          <div><dt>Maior</dt><dd>${esc(reais(resumo.maior.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.maior.data))}</dd></div>
          <div><dt>Média</dt><dd>${esc(reais(resumo.mediaCentavos))}</dd><dd class="hp-sub">${resumo.quantidade} registros desde ${esc(dataCurta(resumo.primeiraData))}</dd></div>
        </dl>`
      : '';

    container.innerHTML = `
      <article class="hp-resultado">
        <h2 class="hp-titulo">${esc(titulo)}</h2>
        <p class="hp-loja">${esc(NOMES_LOJA[produto.loja] || produto.loja)} · código ${esc(produto.id)}${
          url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">abrir na loja<span class="hp-sr"> (abre em nova aba)</span></a>` : ''
        }</p>
        ${cartoes}
        <p class="hp-veredito">${esc(resumo ? resumo.veredito : '')}</p>
        ${avisos ? `<ul class="hp-avisos">${avisos}</ul>` : ''}
        ${pontos.length ? `<figure class="hp-figura">${grafico(pontos, container.clientWidth)}<figcaption>${legenda(pontos)}</figcaption></figure>${tabela(pontos)}` : ''}
      </article>`;
  }

  // Redesenha quando a largura muda bastante (girar o celular, redimensionar a janela).
  const desenhados = new Map();
  function desenharGuardando(container, dados) {
    desenhados.set(container, { dados, largura: container.clientWidth });
    desenhar(container, dados);
  }
  let espera = null;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      for (const [container, info] of desenhados) {
        if (!container.isConnected || !container.firstElementChild) continue;
        if (Math.abs(container.clientWidth - info.largura) < 40) continue;
        const aberto = container.querySelector('details')?.open;
        desenharGuardando(container, info.dados);
        if (aberto) container.querySelector('details').open = true;
      }
    }, 200);
  });

  window.HistoricoTela = { desenhar: desenharGuardando, reais, dataCurta, esc };
})();
