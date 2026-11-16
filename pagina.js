// Página pública: manda o link ao servidor, que monta o histórico na hora (sem pedido nem login).
// Se o servidor não responder, mostra o histórico que o robô diário já salvou em dados/.
// Quem digita o nome do produto em vez do link vê os produtos achados (salvos e na Amazon) e escolhe um.
(function () {
  const { desenhar, desenharEncontrados, reais, dataCurta, esc } = window.HistoricoTela;
  const SERVIDOR = (window.HISTORICO_SERVIDOR || '').replace(/\/$/, '');
  const form = document.getElementById('form-busca');
  const campo = document.getElementById('link');
  const botao = form.querySelector('button[type="submit"]');
  const status = document.getElementById('status');
  const resultado = document.getElementById('resultado');
  let consultaAtual = 0;
  let produtosSalvos = [];

  /** Texto colado é link (com ou sem https://)? Senão, é o nome do produto. */
  function comoLink(texto) {
    if (/^https?:\/\//i.test(texto)) return texto;
    if (/^(www\.)?(amazon\.com\.br|mercadoli(vre|bre)\.com\.br|amzn\.to|a\.co|meli\.la|produto\.mercadolivre\.com\.br|buscape\.com\.br)\//i.test(texto)) {
      return `https://${texto}`;
    }
    return null;
  }

  function normalizar(texto) {
    return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Produtos já acompanhados cujo título tem todas as palavras digitadas. */
  function salvosParecidos(nome) {
    const palavras = normalizar(nome).split(' ').filter((p) => p.length >= 2);
    if (!palavras.length) return [];
    return produtosSalvos
      .filter((p) => {
        const titulo = ` ${normalizar(p.titulo || '')} `;
        return palavras.every((w) => titulo.includes(` ${w}`));
      })
      .map((p) => ({
        titulo: p.titulo || p.id,
        link: p.url,
        chave: `${p.loja}_${p.id}`,
        precoCentavos: p.ultimoPrecoCentavos,
        imagem: null,
      }));
  }

  async function procurarPorNome(nome) {
    const minhaConsulta = ++consultaAtual;
    resultado.innerHTML = '';
    botao.disabled = true;
    status.textContent = `Procurando “${nome}”…`;
    const acompanhados = salvosParecidos(nome);
    let produtos = [];
    let erro = '';
    try {
      if (!SERVIDOR) throw new Error('a busca pelo nome precisa do servidor');
      const resp = await fetch(`${SERVIDOR}/api/historico?nome=${encodeURIComponent(nome)}`);
      const corpo = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(corpo.erro || `o servidor respondeu ${resp.status}`);
      produtos = corpo.produtos || [];
    } catch (e) {
      erro = `${e.message.replace(/\.$/, '')}. Tente de novo em alguns minutos ou cole o link do produto.`;
    }
    if (minhaConsulta !== consultaAtual) return;
    botao.disabled = false;
    status.textContent = '';
    history.replaceState(null, '', `${location.pathname}?busca=${encodeURIComponent(nome)}`);
    desenharEncontrados(resultado, nome, { produtos, acompanhados, erro }, (link, chave) => {
      campo.value = link;
      consultar(link, chave);
      document.getElementById('painel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Mesma regra de robo/motor.ts (identificarLink), para achar o histórico salvo sem o servidor.
  function identificarLink(texto) {
    let url;
    try {
      url = new URL(texto.trim());
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (/(^|\.)amazon\.com\.br$/.test(host)) {
      const m = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
      return m ? { loja: 'amazon', id: m[1].toUpperCase() } : null;
    }
    if (/(^|\.)mercadoli(vre|bre)\.com\.br$/.test(host)) {
      const m = (url.pathname + url.search).match(/MLB-?(\d{6,})/i);
      return m ? { loja: 'mercadolivre', id: 'MLB' + m[1] } : null;
    }
    if (/(^|\.)buscape\.com\.br$/.test(host)) {
      const m = url.pathname.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
      return m && !/^(search|lead|busca|ofertas|cupons|promocoes)$/.test(m[1]) ? { loja: 'buscape', id: m[2] } : null;
    }
    return null;
  }

  async function lerSalvo(chave) {
    const resp = await fetch(`dados/produtos/${encodeURIComponent(chave)}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Lê a resposta do servidor linha a linha, mostrando cada etapa, e devolve o resultado. */
  async function perguntarAoServidor(link, minhaConsulta) {
    const resp = await fetch(`${SERVIDOR}/api/historico?link=${encodeURIComponent(link)}`);
    if (!resp.ok || !resp.body) {
      const corpo = await resp.json().catch(() => ({}));
      throw new Error(corpo.erro || `o servidor respondeu ${resp.status}`);
    }
    const leitor = resp.body.getReader();
    const decodificador = new TextDecoder();
    let resto = '';
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      resto += decodificador.decode(value, { stream: true });
      const linhas = resto.split('\n');
      resto = linhas.pop();
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        const msg = JSON.parse(linha);
        if (msg.erro) throw new Error(msg.erro);
        if (msg.resultado) return msg.resultado;
        if (msg.etapa && minhaConsulta === consultaAtual) status.textContent = msg.etapa;
      }
    }
    throw new Error('a resposta do servidor veio incompleta');
  }

  async function consultar(link, chaveSalva) {
    const minhaConsulta = ++consultaAtual;
    resultado.innerHTML = '';
    if (!link && !chaveSalva) {
      status.textContent = 'Cole o link ou digite o nome do produto.';
      campo.focus();
      return;
    }
    botao.disabled = true;
    status.textContent = 'Consultando…';
    const produto = link ? identificarLink(link) : null;
    const chave = chaveSalva || (produto ? `${produto.loja}_${produto.id}` : null);

    try {
      let dados = null;
      let aviso = '';
      if (SERVIDOR && link) {
        try {
          dados = await perguntarAoServidor(link, minhaConsulta);
        } catch (erro) {
          if (/Não reconheci/.test(erro.message)) throw erro;
          aviso = `O servidor não respondeu agora (${erro.message}).`;
        }
      }
      if (!dados && chave) {
        dados = await lerSalvo(chave);
        if (dados && aviso) dados.avisos = [`${aviso} Mostrando o histórico salvo até ${dataCurta(dados.atualizadoEm)}.`];
      }
      if (minhaConsulta !== consultaAtual) return;
      if (!dados) {
        status.textContent = aviso
          ? `${aviso} Tente de novo em alguns minutos.`
          : 'Não reconheci o link. Use o link de um produto da amazon.com.br ou do mercadolivre.com.br.';
        return;
      }
      status.textContent = '';
      desenhar(resultado, dados);
      const chaveFinal = dados.chave || chave || `${dados.produto.loja}_${dados.produto.id}`;
      history.replaceState(null, '', `${location.pathname}?produto=${encodeURIComponent(chaveFinal)}`);
    } catch (erro) {
      if (minhaConsulta === consultaAtual) status.textContent = erro.message;
    } finally {
      if (minhaConsulta === consultaAtual) botao.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = campo.value.trim();
    const link = comoLink(texto);
    if (link || !texto) consultar(link || '', null);
    else procurarPorNome(texto);
    document.getElementById('painel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const NOMES_LOJA = { amazon: 'Amazon', mercadolivre: 'Mercado Livre', buscape: 'Buscapé' };
  const CORES_LOJA = ['#5b2bd1', '#0a5fc4', '#c2410c', '#047857', '#b91c1c', '#7c3aed', '#0f766e', '#a21caf', '#1d4ed8', '#9a3412'];
  const MAX_CARTOES = 20;

  function corDaLoja(nome) {
    let h = 0;
    for (const c of nome) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return CORES_LOJA[h % CORES_LOJA.length];
  }

  function iniciais(nome) {
    const palavras = nome.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
    const letras = palavras.length > 1 ? palavras[0][0] + palavras[1][0] : palavras[0].slice(0, 2);
    return letras.toUpperCase();
  }

  /** Minigráfico do preço na loja do link (linha + área), em coordenadas 0–100 × 0–50. */
  function minigrafico(dados) {
    const pontos = (dados.pontos || []).filter((p) => !p.loja).sort((a, b) => a.data.localeCompare(b.data));
    const usados = pontos.length > 1 ? pontos : (dados.pontos || []).slice().sort((a, b) => a.data.localeCompare(b.data));
    if (usados.length < 2) return '';
    const t = usados.map((p) => Date.parse(p.data));
    const v = usados.map((p) => p.precoCentavos);
    const t0 = Math.min(...t), t1 = Math.max(...t) || t0 + 1;
    const v0 = Math.min(...v), v1 = Math.max(...v);
    const x = (i) => (((t[i] - t0) / (t1 - t0 || 1)) * 100).toFixed(2);
    const y = (i) => (v1 === v0 ? 25 : 46 - ((v[i] - v0) / (v1 - v0)) * 42).toFixed(2);
    const linha = usados.map((_, i) => `${i ? 'L' : 'M'}${x(i)} ${y(i)}`).join(' ');
    return `<svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
      <path class="area" d="${linha} L100 50 L0 50 Z"/><path class="linha" d="${linha}"/></svg>`;
  }

  function cartao(p) {
    const chave = `${p.loja}_${p.id}`;
    const ehMenor = p.ultimoPrecoCentavos != null && p.ultimoPrecoCentavos <= p.menorPrecoCentavos;
    const selo = ehMenor
      ? '<span class="selo menor">Menor preço já visto</span>'
      : `<span class="selo">${p.lojas > 1 ? `${p.lojas} lojas` : esc(NOMES_LOJA[p.loja] || p.loja)}</span>`;
    const menor = ehMenor ? '' : `menor já visto <b>${esc(reais(p.menorPrecoCentavos))}</b> · `;
    return `<li><a class="cartao" href="?produto=${esc(encodeURIComponent(chave))}" data-chave="${esc(chave)}" data-url="${esc(p.url)}">
      <span class="cartao-grafico esqueleto" data-grafico="${esc(chave)}"></span>
      ${selo}
      <span class="cartao-nome">${esc(p.titulo || p.id)}</span>
      <span class="cartao-preco">${esc(reais(p.ultimoPrecoCentavos))}</span>
      <span class="cartao-detalhe">${menor}${p.quantidade} preços · conferido em ${esc(dataCurta(p.atualizadoEm))}</span>
    </a></li>`;
  }

  function desenharLojas(arquivos) {
    const ul = document.getElementById('lojas');
    const contagem = new Map();
    for (const dados of arquivos) {
      if (!dados) continue;
      // No produto do Buscapé a série sem loja é o menor preço do dia, não uma loja.
      const pontos = (dados.pontos || []).filter((p) => p.loja || dados.produto.loja !== 'buscape');
      const nomes = new Set(pontos.map((p) => p.loja || NOMES_LOJA[dados.produto.loja] || dados.produto.loja));
      for (const nome of nomes) contagem.set(nome, (contagem.get(nome) || 0) + 1);
    }
    ul.removeAttribute('aria-busy');
    if (!contagem.size) {
      ul.closest('section').hidden = true;
      return;
    }
    ul.innerHTML = [...contagem]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))
      .map(([nome, n]) => `<li class="loja">
        <span class="loja-bola" style="background:${corDaLoja(nome)}" aria-hidden="true">${esc(iniciais(nome))}</span>
        <span class="loja-nome" title="${esc(nome)}">${esc(nome)}</span>
        <span class="loja-conta">${n} ${n > 1 ? 'produtos' : 'produto'}</span>
      </li>`)
      .join('');
  }

  function ligarSetas(ul) {
    const setas = document.querySelector('.setas');
    const [antes, depois] = setas.querySelectorAll('.seta');
    const atualizar = () => {
      const sobra = ul.scrollWidth - ul.clientWidth;
      setas.hidden = sobra < 4;
      antes.disabled = ul.scrollLeft < 4;
      depois.disabled = ul.scrollLeft > sobra - 4;
    };
    setas.querySelectorAll('.seta').forEach((b) =>
      b.addEventListener('click', () => ul.scrollBy({ left: Number(b.dataset.direcao) * ul.clientWidth * 0.9 })),
    );
    ul.addEventListener('scroll', atualizar, { passive: true });
    addEventListener('resize', atualizar);
    atualizar();
  }

  async function carregarLista() {
    const lista = document.getElementById('lista');
    try {
      const resp = await fetch(`dados/indice.json?t=${Date.now()}`, { cache: 'no-store' });
      const { produtos } = await resp.json();
      produtosSalvos = produtos;
      if (!produtos.length) {
        lista.textContent = 'Nenhum produto ainda. Consulte um link na busca e ele aparece aqui depois da conferência diária.';
        desenharLojas([]);
        return;
      }
      const mostrados = produtos.slice(0, MAX_CARTOES);
      lista.innerHTML = `<ul class="cartoes" id="cartoes">${mostrados.map(cartao).join('')}</ul>`;
      const ul = lista.querySelector('ul');
      ul.querySelectorAll('a[data-chave]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          campo.value = a.dataset.url;
          consultar(a.dataset.url, a.dataset.chave);
          document.getElementById('painel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }),
      );
      ligarSetas(ul);

      const arquivos = await Promise.all(
        mostrados.map(async (p) => {
          const chave = `${p.loja}_${p.id}`;
          const dados = await lerSalvo(chave).catch(() => null);
          const alvo = ul.querySelector(`[data-grafico="${CSS.escape(chave)}"]`);
          if (alvo) {
            alvo.classList.remove('esqueleto');
            alvo.innerHTML = dados ? minigrafico(dados) : '';
          }
          return dados;
        }),
      );
      desenharLojas(arquivos);
    } catch {
      lista.textContent = 'Não foi possível carregar a lista agora.';
      desenharLojas([]);
    }
  }

  const carregando = carregarLista();
  const parametros = new URLSearchParams(location.search);
  const linkInicial = parametros.get('link');
  const buscaInicial = parametros.get('busca');
  const inicial = parametros.get('produto');
  if (buscaInicial && !linkInicial) {
    // ?busca=... repete a busca pelo nome (dá para compartilhar o endereço).
    campo.value = buscaInicial;
    carregando.then(() => procurarPorNome(buscaInicial));
  } else if (linkInicial) {
    // ?link=... consulta na hora (dá para compartilhar o endereço de uma consulta).
    campo.value = linkInicial;
    consultar(linkInicial, null);
  } else if (inicial && /^(amazon|mercadolivre|buscape)_[A-Za-z0-9-]+$/.test(inicial)) {
    // Abre direto o histórico salvo (rápido); quem quiser o mais novo consulta o link.
    lerSalvo(inicial).then((dados) => dados && desenhar(resultado, dados));
  }
})();
