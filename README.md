# EDHProxy

Extensão para navegadores Chromium (Chrome, Edge, Brave, Opera, Vivaldi) que troca a arte das cartas no [edhplay.com](https://edhplay.com) e compartilha suas artes com quem está na mesma sala e também usa a extensão.

## Instalar

1. Baixe o **edhproxy.zip** da [última release](../../releases/latest) e extraia numa pasta sua, por exemplo `Documentos\EDHProxy`.
   Evite pastas de sistema como `AppData` ou `Arquivos de Programas`: o navegador não deixa a extensão se atualizar nelas.
2. Abra `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha essa pasta.

Funciona em Windows, macOS e Linux, em navegadores Chromium (Chrome, Edge, Brave, Opera, Vivaldi).

## Atualizar

Quando sai versão nova, o ícone da extensão ganha um **↑** e o popup mostra o aviso com o botão **Atualizar agora**. Ele abre uma página da extensão que baixa a versão nova do GitHub e salva os arquivos na pasta da extensão; depois ela se recarrega sozinha. Nada roda fora do navegador nem é instalado no sistema; a extensão só consulta o GitHub a cada 6 horas para saber se há versão nova.

Na primeira vez, o navegador pede para você escolher a pasta da extensão (a mesma do "Carregar sem compactação") e permissão para salvar nela. Se pedir de novo depois, é só confirmar.

Também dá para atualizar à mão: baixe o zip novo e extraia por cima da mesma pasta. A extensão percebe a troca e se recarrega em até 1 minuto.

## Publicar uma versão nova (para quem mantém o repositório)

1. Aumente `"version"` no `manifest.json` (ex.: `1.2.0`) e faça commit.
2. Crie e envie a tag com o mesmo número: `git tag v1.2.0` e `git push origin v1.2.0`.
3. O GitHub Actions ([release.yml](.github/workflows/release.yml)) monta o zip, preenche o nome do repositório no manifest e publica a release. A extensão de todo mundo passa a mostrar o aviso com o botão **Atualizar agora**.

## Usar

1. No seu deck (`edhplay.com/decks/<id>`), clique numa carta e escolha **Mudar Impressão** (Change Printing).
2. Antes das impressões aparece a pasta **Custom**. Ela abre as artes que você já enviou para aquela carta.
3. Em **+ Adicionar**, cole a URL de uma imagem (https) ou escolha um arquivo e, se quiser, dê um nome. A imagem deve ser a carta inteira (alter, proxy): ela substitui a carta toda.
4. **Salvar** coloca a arte na pasta já selecionada (borda azul); o **Confirm** do edhplay aplica em todas as suas cópias da carta e **Cancel** descarta, como numa impressão normal.

No painel Custom: clique numa arte para selecioná-la e depois em **Confirm** (borda verde = em uso, azul = selecionada); **Original** (ou clicar na impressão atual) + Confirm volta à arte normal; escolher outra impressão + Confirm troca a impressão e desliga a arte custom. Use o lápis para dar/trocar o nome e no ✕ para apagar. Os nomes ficam só no seu navegador; nunca vão para a sala.

As artes só são editadas na página do deck; na mesa elas só são exibidas.

Os textos da extensão seguem o idioma escolhido no edhplay (inglês, espanhol, italiano, alemão, francês, português, japonês ou holandês) e mudam junto quando você troca o idioma do site. O popup usa o último idioma visto no site.

O popup (ícone da extensão) mostra o status da sala, quem mais está com a extensão, sua lista de artes e permite exportar/importar.

## Como funciona o compartilhamento

- Em `/games/<sala>/play` ou `/spectate`, a extensão entra num canal do [ntfy.sh](https://ntfy.sh) (pub/sub público e gratuito) cujo nome é um hash do ID da sala.
- Ela publica a lista das suas artes (só as URLs) e recebe a dos outros. Quem entra depois recebe o histórico (o ntfy.sh guarda por ~12h).
- **Arquivos locais** ficam guardados só no seu navegador. Durante uma partida, quando há outro jogador com a extensão na sala e a carta aparece na mesa, a extensão sobe uma cópia temporária no [litterbox.catbox.moe](https://litterbox.catbox.moe) (expira em 1h) e compartilha esse link. Cada partida sobe de novo; partidas com mais de ~50 min renovam o envio. Quem tiver o link pode ver a imagem nesse período. Desligue em Popup → "Compartilhar arquivos locais" para mantê-los só com você.
- Artes por URL (`https://`) são compartilhadas direto, sem upload. Links do Discord expiram.
- Cada arte vale só para as cartas do dono. A extensão lê o dono de cada carta (`owner_id`) direto do jogo e anuncia na sala qual jogador você é. Se você e um amigo usam a mesma carta, cada um vê a própria arte na sua cópia e a do outro na cópia dele. Cartas de quem não usa a extensão ficam com a arte original.
- O popup mostra o nome de usuário do edhplay de quem está com a extensão. O nome é lido do próprio jogo, na sua máquina; ele não é enviado pelo canal de sincronização.
- Enquanto a extensão ainda não sabe quem você é (ela descobre pela sua mão), cartas que nenhum outro jogador reivindicou são tratadas como suas.
- Qualquer um que saiba o ID da sala poderia ler o canal. Não use imagens privadas.
- Dá para usar outro servidor ntfy (ex.: self-hosted) em Popup → Avançado; todos na sala precisam usar o mesmo.

## Limitações

- Depende de como o edhplay renderiza as cartas hoje (`<img>` do Scryfall) e dos dados internos do React (`card.owner_id`, `localPlayerId`, lidos por `page-owner.js`). Se o site mudar, a extensão pode parar de funcionar.
- A permissão `https://*/*` existe para publicar no servidor ntfy escolhido no popup (que pode ser self-hosted).
