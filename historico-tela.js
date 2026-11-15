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

  const MAX_SERIES = 6;

  /** Separa os pontos por loja: a loja do link primeiro, depois da mais barata hoje à mais cara. */
  function series(pontos, produto) {
    const grupos = new Map();
    for (const p of pontos) {
      const chave = p.loja || '';
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(p);
    }
    const lista = [...grupos].map(([chave, doGrupo]) => {
      const ordenados = doGrupo.sort((a, b) => a.data.localeCompare(b.data));
      return {
        chave,
        nome: chave || NOMES_LOJA[produto.loja] || produto.loja,
        pontos: ordenados,
        ultimo: ordenados[ordenados.length - 1],
        menor: ordenados.reduce((m, p) => (p.precoCentavos < m.precoCentavos ? p : m)),
      };
    });
    lista.sort((a, b) => {
      if (!a.chave) return -1;
      if (!b.chave) return 1;
      return a.ultimo.precoCentavos - b.ultimo.precoCentavos;
    });
    lista.forEach((s, i) => (s.cor = i < MAX_SERIES ? i + 1 : 0));
    return lista;
  }

  function grafico(todas, largura) {
    const visiveis = todas.filter((s) => s.cor > 0);
    const pontos = visiveis.flatMap((s) => s.pontos);
    // Desenha na largura real da tela, para o texto do eixo não encolher no celular.
    const L = Math.round(Math.max(300, Math.min(900, largura || 720)));
    const A = L < 500 ? 240 : 300;
    const rotular = visiveis.length > 1 && visiveis.length <= 4 && L >= 560;
    const m = { esq: 96, dir: rotular ? 128 : 12, topo: 16, base: 40 };
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
      const ancora = i === 0 ? 'start' : i === nDatas ? 'end' : 'middle';
      marcasX.push(
        `<text x="${x(t)}" y="${A - m.base + 22}" text-anchor="${ancora}" class="hp-eixo">${esc(dataCurta(new Date(t).toISOString()))}</text>`,
      );
    }

    const desenhos = [...visiveis].reverse().map((s) => {
      const caminho = s.pontos
        .map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.data)).toFixed(1)},${y(p.precoCentavos).toFixed(1)}`)
        .join(' ');
      const bolinhas = s.pontos
        .map(
          (p) =>
            `<circle cx="${x(Date.parse(p.data)).toFixed(1)}" cy="${y(p.precoCentavos).toFixed(1)}" r="4.5" class="hp-ponto">` +
            `<title>${esc(s.nome)} · ${esc(dataCurta(p.data))}: ${esc(reais(p.precoCentavos))} (${esc(NOMES_FONTE[p.fonte] || p.fonte)})</title></circle>`,
        )
        .join('');
      return `<g class="hp-serie hp-s${s.cor}">${s.pontos.length > 1 ? `<path d="${caminho}" class="hp-linha"/>` : ''}${bolinhas}</g>`;
    });

    // Nome da loja no fim de cada linha (até 4 lojas), afastando os que ficariam sobrepostos.
    let rotulos = '';
    if (rotular) {
      const fins = visiveis
        .map((s) => ({ s, yy: y(s.ultimo.precoCentavos), xx: x(Date.parse(s.ultimo.data)) }))
        .sort((a, b) => a.yy - b.yy);
      for (let i = 1; i < fins.length; i++) fins[i].yy = Math.max(fins[i].yy, fins[i - 1].yy + 15);
      rotulos = fins
        .map(({ s, yy, xx }) => `<text x="${(xx + 9).toFixed(1)}" y="${(yy + 4).toFixed(1)}" class="hp-rotulo">${esc(s.nome.slice(0, 16))}</text>`)
        .join('');
    }

    const resumoTexto = visiveis
      .map((s) => `${s.nome}: último ${reais(s.ultimo.precoCentavos)}, menor ${reais(s.menor.precoCentavos)}`)
      .join('; ');
    const descricao = `Gráfico do preço de ${dataCurta(new Date(t0).toISOString())} a ${dataCurta(new Date(t1).toISOString())}. ${resumoTexto}. Os valores estão nas tabelas.`;

    return `<svg viewBox="0 0 ${L} ${A}" class="hp-svg" role="img" aria-label="${esc(descricao)}">
      ${linhasY.join('')}${marcasX.join('')}
      ${desenhos.join('')}
      ${rotulos}
    </svg>`;
  }

  function legenda(todas) {
    const visiveis = todas.filter((s) => s.cor > 0);
    const fora = todas.length - visiveis.length;
    const itens = visiveis.map((s) => `<li><span class="hp-marca hp-s${s.cor}" aria-hidden="true"></span>${esc(s.nome)}</li>`);
    if (fora > 0) itens.push(`<li>+${fora} ${fora === 1 ? "loja" : "lojas"} só na tabela</li>`);
    return `<ul class="hp-legenda">${itens.join('')}</ul>`;
  }

  function tabelaLojas(todas) {
    if (todas.length < 2) return '';
    const linhas = todas
      .map(
        (s) => `<tr>
          <th scope="row">${s.cor ? `<span class="hp-marca hp-s${s.cor}" aria-hidden="true"></span>` : ''}${esc(s.nome)}</th>
          <td>${esc(reais(s.ultimo.precoCentavos))} <span class="hp-data">${esc(dataCurta(s.ultimo.data))}</span></td>
          <td>${esc(reais(s.menor.precoCentavos))} <span class="hp-data">${esc(dataCurta(s.menor.data))}</span></td>
          <td>${s.pontos.length}</td>
        </tr>`,
      )
      .join('');
    return `<div class="hp-rolagem" tabindex="0" role="region" aria-label="Preço em cada loja (role para o lado)"><table class="hp-tabela hp-lojas">
        <caption>Preço em cada loja</caption>
        <thead><tr><th scope="col">Loja</th><th scope="col">Último preço</th><th scope="col">Menor já visto</th><th scope="col">Registros</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>`;
  }

  function tabela(pontos, nomePrincipal) {
    const linhas = [...pontos]
      .reverse()
      .map((p) => {
        const link = linkSeguro(p.link);
        const nomeFonte = esc(NOMES_FONTE[p.fonte] || p.fonte);
        const origem = link
          ? `<a href="${esc(link)}" target="_blank" rel="noopener">${nomeFonte}<span class="hp-sr"> (abre em nova aba)</span></a>`
          : nomeFonte;
        return `<tr><td>${esc(dataCurta(p.data))}</td><td>${esc(p.loja || nomePrincipal)}</td><td>${esc(reais(p.precoCentavos))}</td><td>${p.precoDeCentavos ? esc(reais(p.precoDeCentavos)) : '—'}</td><td>${origem}</td></tr>`;
      })
      .join('');
    return `<details class="hp-detalhes"><summary>Ver todos os ${pontos.length} registros</summary>
      <div class="hp-rolagem" tabindex="0" role="region" aria-label="Todos os registros (role para o lado)"><table class="hp-tabela">
        <caption class="hp-sr">Preços registrados, do mais novo ao mais antigo</caption>
        <thead><tr><th scope="col">Data</th><th scope="col">Loja</th><th scope="col">Preço</th><th scope="col">Preço "de"</th><th scope="col">Fonte</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div></details>`;
  }

  /** O menor preço visto nos últimos 3 dias entre as lojas (para dizer onde está mais barato). */
  function maisBaratoAgora(todas) {
    const limite = Date.now() - 3 * 86400000;
    const recentes = todas.filter((s) => Date.parse(s.ultimo.data) >= limite);
    if (recentes.length < 2) return '';
    const melhor = recentes.reduce((a, b) => (b.ultimo.precoCentavos < a.ultimo.precoCentavos ? b : a));
    return `Hoje o menor preço entre as ${recentes.length} lojas é ${reais(melhor.ultimo.precoCentavos)}, na ${melhor.nome}.`;
  }

  /** dados: { produto: {loja, id, url}, titulo, pontos, resumo, avisos?, comparador? } */
  function desenhar(container, dados) {
    const { produto, resumo } = dados;
    const pontos = [...(dados.pontos || [])].sort((a, b) => a.data.localeCompare(b.data));
    const url = linkSeguro(produto.url);
    const nomePrincipal = NOMES_LOJA[produto.loja] || produto.loja;
    const titulo = dados.titulo || `${nomePrincipal} ${produto.id}`;
    const avisos = (dados.avisos || []).map((a) => `<li>${esc(a)}</li>`).join('');
    const todas = series(pontos, produto);
    const comparador = dados.comparador && linkSeguro(dados.comparador.url);
    const novaAba = '<span class="hp-sr"> (abre em nova aba)</span>';

    const cartoes = resumo && resumo.quantidade
      ? `<dl class="hp-cartoes">
          <div><dt>Último preço na ${esc(nomePrincipal)}</dt><dd>${esc(reais(resumo.atual.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.atual.data))}</dd></div>
          <div><dt>Menor</dt><dd>${esc(reais(resumo.menor.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.menor.data))}</dd></div>
          <div><dt>Maior</dt><dd>${esc(reais(resumo.maior.precoCentavos))}</dd><dd class="hp-sub">${esc(dataCurta(resumo.maior.data))}</dd></div>
          <div><dt>Média</dt><dd>${esc(reais(resumo.mediaCentavos))}</dd><dd class="hp-sub">${resumo.quantidade} registros desde ${esc(dataCurta(resumo.primeiraData))}</dd></div>
        </dl>`
      : '';
    const barato = maisBaratoAgora(todas);
    const links = [
      `${esc(nomePrincipal)} · código ${esc(produto.id)}`,
      url ? `<a href="${esc(url)}" target="_blank" rel="noopener">abrir na loja${novaAba}</a>` : '',
      comparador ? `<a href="${esc(comparador)}" target="_blank" rel="noopener">outras lojas no Buscapé${novaAba}</a>` : '',
    ].filter(Boolean);

    container.innerHTML = `
      <article class="hp-resultado">
        <h2 class="hp-titulo">${esc(titulo)}</h2>
        <p class="hp-loja">${links.join(' · ')}</p>
        ${cartoes}
        <p class="hp-veredito">${esc(resumo ? resumo.veredito : '')}</p>
        ${barato ? `<p class="hp-veredito">${esc(barato)}</p>` : ''}
        ${avisos ? `<ul class="hp-avisos">${avisos}</ul>` : ''}
        ${pontos.length ? `<figure class="hp-figura">${grafico(todas, container.clientWidth)}<figcaption>${legenda(todas)}</figcaption></figure>${tabelaLojas(todas)}${tabela(pontos, nomePrincipal)}` : ''}
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
