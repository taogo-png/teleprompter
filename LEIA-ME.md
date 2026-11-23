# Teleprompter

App de iPhone que grava vídeo com a câmera e mostra o roteiro rolando por cima, perto da lente. O PC controla tudo: texto, velocidade, gravação e o modo que acompanha a sua voz.

## Uma vez só (preparação)

1. Instale o **Node.js 22 LTS** no PC: https://nodejs.org
2. Crie uma conta grátis no Expo: https://expo.dev/signup
3. No iPhone, baixe o **Expo Go** na App Store e entre com essa conta.
4. Descompacte esta pasta, abra um terminal dentro dela e rode:

```
npm install
npx expo login
```

## Toda vez que for gravar

1. PC e iPhone no **mesmo Wi-Fi**.
2. No terminal, dentro da pasta:

```
npm run dev
```

3. Na primeira vez, o Windows pergunta sobre o firewall: marque **Redes privadas** e permita.
4. Leia o QR code que aparece no terminal com a câmera do iPhone. O app abre no Expo Go.
5. No PC, abra **http://localhost:3333** no Chrome ou no Edge. Esse é o painel de controle.

A bolinha no canto do app fica verde e mostra "PC" quando os dois estão conectados. Se ficar "offline", toque nela e digite o IP do PC que aparece no terminal.

## Usando

- **Gravar**: botão vermelho no iPhone, ou "Gravar no iPhone" no painel (atalho R). Tem contagem de 3 segundos. Quando você para, abre o menu de compartilhar: toque em **Salvar vídeo** para mandar para a galeria.
- **Rodar texto**: o texto rola na velocidade escolhida. No iPhone, um toque no texto roda/pausa e arrastar ajusta a posição.
- **Seguir minha voz**: no painel do PC. O microfone do PC ouve você e o texto no iPhone vai até a linha que você está falando. Se você pular um trecho ou voltar, ele acompanha. Funciona no Chrome e no Edge e precisa de internet, porque o reconhecimento de fala do navegador roda no servidor do Google ou da Microsoft.
- O roteiro fica salvo em `pc/roteiro.txt`.

## Se o Expo Go disser que o projeto é incompatível

O projeto está no Expo SDK 58. Se o Expo Go da App Store ainda estiver numa versão anterior, rode:

```
npm install expo@~57.0.0
npx expo install --fix
```

e rode `npm run dev` de novo.
