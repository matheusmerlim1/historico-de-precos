# Histórico de preço

Página pública: **https://matheusmerlim1.github.io/historico-de-precos/**

Cole o link de um produto da Amazon (amazon.com.br) ou do Mercado Livre e veja como o preço mudou
ao longo do tempo, nessa loja e nas outras que vendem o mesmo produto (KaBuM!, Magazine Luiza,
Casas Bahia...): último preço, menor, maior, média, onde está mais barato hoje e o gráfico com uma
linha por loja. Sem login e sem pedido: a consulta é feita na hora.

Dá para compartilhar uma consulta: `https://matheusmerlim1.github.io/historico-de-precos/?link=<link do produto>`.

## Como funciona

| Parte | Onde roda | O que faz |
|---|---|---|
| Página (`index.html`, `pagina.js`, `historico-tela.*`) | GitHub Pages | manda o link ao servidor e desenha o resultado |
| Servidor (`servidor/api.ts` → `api/historico.mjs`) | Vercel (grátis) | monta o histórico na hora e devolve o andamento e o resultado |
| Robô (`robo/atualizar.ts`) | GitHub Actions, todo dia às 9h17 UTC | soma o preço do dia aos produtos da lista em `dados/` |

O navegador não consegue ler o Internet Archive nem as lojas direto (eles não liberam acesso a partir
de outros sites), por isso existe o servidor. Fontes de preço (`robo/motor.ts`):

- cópias antigas da página do produto guardadas no Internet Archive;
- o preço de hoje na loja do link;
- outras lojas: a página do mesmo produto (mesmo modelo e capacidade) no comparador Buscapé, hoje e
  nas cópias antigas dela.

Se o servidor não responder, a página mostra o histórico que o robô já salvou em `dados/`.

## Publicar o servidor (uma vez)

1. Entrar em https://vercel.com com a conta do GitHub.
2. **Add New → Project**, escolher o repositório `historico-de-precos` e clicar em **Deploy** (sem
   mudar nada: não há etapa de build; o `vercel.json` já dá 60 s para a função).
3. Se o endereço do projeto não for `https://historico-de-precos.vercel.app`, trocar em `config.js`.

Depois disso a Vercel publica sozinha a cada push.

## Mexer no código

O servidor é um arquivo só, gerado a partir do TypeScript (rodar depois de mudar `servidor/` ou `robo/`):

```
npx esbuild@0.24.0 servidor/api.ts --bundle --platform=node --format=esm --target=node20 --outfile=api/historico.mjs --legal-comments=none
node ferramentas/servidor-local.mjs      # testa em http://127.0.0.1:8787/api/historico?link=...
```

Robô no PC (Node 22 ou mais novo, sem instalar nada):

```
node --experimental-strip-types robo/atualizar.ts https://www.amazon.com.br/dp/B0CQD9VK7X
node --experimental-strip-types robo/atualizar.ts --todos
```

`robo/motor.ts`, `historico-tela.js` e `historico-tela.css` são cópias dos arquivos do app
**Comparador de Promoções do Telegram** (repositório privado), cuja aba "Histórico de preço" é a
versão privada desta página: ela também usa as mensagens dos grupos de promoção do Telegram, que
exigem login. Os testes do motor estão lá (`npm test`).
