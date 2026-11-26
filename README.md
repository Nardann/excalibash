<p align="center">
  <img src="web/public/favicon.svg" width="72" alt="">
</p>

<h1 align="center">Excalibash</h1>

<p align="center">
  Des tableaux Excalidraw avec de vrais terminaux dessus.<br>
  On dessine le schéma réseau du TP, on clique sur une machine, un shell s'ouvre.
</p>

<p align="center">
  <a href="https://excalibash.fr"><b>excalibash.fr</b></a>
</p>

<p align="center">
  <a href="https://excalibash.fr"><img src="https://img.shields.io/badge/site-excalibash.fr-4f46e5" alt="Site : excalibash.fr"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-AGPL--3.0-1e293b" alt="Licence AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/chiffrement-de%20bout%20en%20bout-1e293b" alt="Chiffrement de bout en bout">
  <img src="https://img.shields.io/badge/docker-compose-2496ed" alt="Docker Compose">
</p>

![Démo : un clic sur une machine du schéma ouvre son shell, puis son site web s'affiche dans le tableau](docs/images/demo.gif)

Tout le TP tient sur un seul tableau, partagé avec le binôme ou le prof. Les dessins, les noms et les terminaux sont chiffrés dans le navigateur : le serveur ne stocke et ne relaie que des données illisibles.

## Fonctionnalités

- **Terminaux sur le canvas.** Une icône de machine porte un ou plusieurs shells, chacun dans sa fenêtre. L'icône se personnalise avec la bibliothèque Excalidraw. <kbd>Alt</kbd>+<kbd>T</kbd> ouvre un shell, <kbd>Alt</kbd>+<kbd>R</kbd> ou un double-clic sur la barre de titre le masque sans l'arrêter. <kbd>Alt</kbd>+<kbd>B</kbd> diffuse la saisie du terminal actif vers les autres terminaux diffusés (comme `synchronize-panes` de tmux ; local à ton onglet, « Tout arrêter » dans l'en-tête ou le dock). <kbd>Ctrl</kbd>+<kbd>Maj</kbd>+<kbd>F</kbd> cherche dans l'historique, et l'en-tête exporte l'historique en `.txt` ou enregistre la sortie en `.cast` (asciinema), le tout dans le navigateur.
- **Historique des tableaux.** Le bouton « Historique » de l'en-tête liste les versions passées (une toutes les 15 minutes de travail au plus, et une à la fin de chaque session), affiche un aperçu et restaure la version choisie. La restauration est une modification normale : elle se synchronise et s'annule avec <kbd>Ctrl</kbd>+<kbd>Z</kbd>, et ne touche ni aux terminaux ni aux sites ouverts. Le serveur ne copie que des chiffrés, déchiffrés dans le navigateur.
- **Telnet et SSH vers les équipements.** Un switch, un routeur ou un PC joignable depuis une machine s'ouvre en Telnet, SSH ou TCP brut dans un terminal du tableau. Le client est intégré à l'agent. L'option « Équipement ancien » réactive les vieux algorithmes SSH (`diffie-hellman-group1-sha1`, `ssh-rsa`, CBC) qui provoquent les erreurs « no matching key exchange method found ».
- **Sites web des machines.** `http://127.0.0.1:80`, l'interface d'un routeur ou un Proxmox du réseau de la machine s'ouvrent dans une fenêtre du tableau ou en plein onglet. La configuration avancée accepte un en-tête Host et le TLS 1.0/1.1 des vieux équipements. Le serveur ne voit ni l'adresse ni les pages.
- **Transfert de fichiers.** Glisse un fichier sur la fenêtre d'un shell local pour l'envoyer dans son dossier courant, ou ouvre « Fichiers » dans l'en-tête pour parcourir ce dossier et télécharger. 200 Mio au maximum, vérification SHA-256, jamais d'écrasement sans confirmation ; réservé aux éditeurs et aux shells locaux (pas Telnet ni SSH). Le serveur ne voit ni noms, ni chemins, ni contenus : voir [docs/SECURITY.md](docs/SECURITY.md).
- **Capture réseau sur un câble.** Dans l'éditeur d'une extrémité de câble dont l'interface est renseignée, « Capturer (pcap) » lance `tcpdump` sur la machine (durée, filtre BPF et taille limités, jamais via un shell) et télécharge le `.pcap` chiffré de bout en bout. Il faut un shell local en cours sur l'icône, et un agent root ou `tcpdump` avec `CAP_NET_RAW`.
- **Export du schéma.** Le bouton d'export du tableau produit une image PNG ou SVG, ou la topologie dessinée par les câbles : fichier Containerlab (`.clab.yml`, kind et image à adapter, IP et VLAN en commentaire, adresses avec masque posées par `exec`), graphe Mermaid (`.mmd`) ou JSON. Tout est généré dans le navigateur ; les interfaces manquantes sont numérotées `eth1`, `eth2`… avec un avertissement. Test : `node --experimental-strip-types web/src/board/topology.test.ts`.
- **Collaboration en temps réel.** Dessin, curseurs, sélections et terminaux partagés.
- **Dossiers partagés.** Partage en lecture ou en édition ; les sous-dossiers suivent. Retirer quelqu'un renouvelle toutes les clés du sous-arbre.
- **Lien public en lecture seule.** Le propriétaire et les éditeurs d'un tableau peuvent créer un lien `/v/<jeton>#<clé>` (expiration d'1, 7 ou 30 jours, ou aucune) qui montre le tableau sans compte et sans les terminaux. La clé de déchiffrement reste dans la partie `#` de l'adresse, que le navigateur n'envoie jamais au serveur. Retirer un membre supprime les liens du tableau.
- **Machines.** Agent Go statique (Linux, macOS, amd64, arm64) qui se connecte en sortie, sans port à ouvrir. Appairage par code court, démarrage avec la machine, reconnexion automatique.
- **Client MCP local.** Un petit programme Node (sans dépendance) expose tes tableaux et terminaux à un client MCP, avec ton propre compte : il déchiffre sur ta machine, comme le navigateur, et le serveur ne voit rien de plus. Lecture seule par défaut. Voir [docs/MCP.md](docs/MCP.md).
- **Comptes.** Le mot de passe ne quitte pas le navigateur et une clé de récupération est remise à l'inscription. « Mon compte » liste les appareils connectés (navigateur et préfixe d'IP approximatifs, dernière activité) et permet de les déconnecter un à un ou tous d'un coup. Les inscriptions se font sur invitation ou sont ouvertes à tous, avec vérification par email. Le panneau d'administration gère les comptes et le stockage sans accès au contenu.

<table>
  <tr>
    <td><img src="docs/images/landing.png" alt="Page d'accueil"></td>
    <td><img src="docs/images/machines.png" alt="Page Machines : trois machines en ligne"></td>
  </tr>
</table>

## Démarrage rapide

```bash
git clone https://github.com/excalibash-fr/excalibash.git
cd excalibash
docker compose up -d --build
```

L'application répond sur <https://localhost:6767>, avec un certificat auto-signé (voir [HTTPS](#https)). Le premier compte créé est administrateur ; il demande le code d'installation affiché dans les logs :

```bash
docker compose logs excalibash | grep "Code d'installation"
```

La clé de récupération affichée à l'inscription est le seul moyen de retrouver un compte après un mot de passe oublié : personne ne peut le réinitialiser, l'administrateur non plus.

Les inscriptions sont fermées par défaut. Elles s'ouvrent dans **Administration → Inscriptions ouvertes à tous** ; sinon, l'administrateur crée des liens d'invitation.

## Configuration

Les variables se placent dans un fichier `.env` à côté de `docker-compose.yml` (ignoré par git).

| Variable | Défaut | Rôle |
|---|---|---|
| `PUBLIC_URL` | URL de la requête | URL publique, utilisée dans les commandes d'installation de l'agent |
| `PROXY_URL` | même hôte, port 6768 | URL publique de l'origine séparée des tunnels web |
| `TLS` | `auto` | `auto` : HTTPS sur les deux ports, avec le certificat fourni ou un certificat auto-signé. `off` : HTTP seul, derrière un reverse proxy qui fait le TLS |
| `TLS_CERT` `TLS_KEY` | vide | chemins PEM d'un certificat fourni (Let's Encrypt, PKI interne), utilisé à la place du certificat auto-signé |
| `TLS_SANS` | vide | noms ou adresses IP supplémentaires du certificat auto-signé, séparés par des virgules |
| `COOKIE_SECURE` | `false` | `true` force l'attribut `Secure` des cookies. Inutile en HTTPS direct ou derrière un proxy qui transmet `X-Forwarded-Proto` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | vide, `587`, `false` | envoi des codes de vérification et des notifications (choisies par chacun dans « Mon compte » ; seuls les partages sont annoncés par défaut). Sans `SMTP_HOST`, les emails ne sont pas vérifiés. `SMTP_SECURE=true` pour le port 465. La page d'administration montre l'état de l'envoi et permet d'envoyer un email de test et de couper la vérification de l'email à l'inscription (activée par défaut) |
| `CONTACT_EMAIL` `LEGAL_NAME` | vide | contact affiché sur la page Confidentialité |
| `REGISTRATIONS_PER_HOUR` | `50` | plafond global d'inscriptions par heure |
| `BIND_ADDR` | `127.0.0.1` | interface où les ports sont publiés. `0.0.0.0` pour un accès direct depuis le réseau |
| `SETUP_CODE` | aléatoire | code exigé pour créer le premier compte (affiché dans les logs s'il n'est pas fixé) |
| `TRUST_PROXY` | réseaux locaux | proxys dont l'en-tête `X-Forwarded-For` est cru (format Express `trust proxy`) |
| `HISTORY_KEEP` | `10` | nombre de dernières versions gardées par tableau (en plus de la dernière de chacun des `HISTORY_DAYS` derniers jours). `0` désactive l'historique |
| `HISTORY_DAYS` | `7` | jours pendant lesquels la dernière version de chaque jour est conservée |
| `HISTORY_MAX_MB` | `5` | taille maximale de l'historique d'un tableau (chiffrés distincts) : les plus anciennes versions sautent au-delà |
| `HISTORY_INTERVAL_MIN` | `15` | délai minimal entre deux versions d'un même tableau, en minutes (`0` : aucune limite, pour les tests) |

## HTTPS

Excalibash exige HTTPS : hors de `localhost`, le navigateur refuse la cryptographie (WebCrypto) d'une page servie en HTTP. L'instance parle donc HTTPS dès le premier démarrage, sur les ports 6767 et 6768. Une requête en HTTP clair est redirigée vers HTTPS sur le même port.

Sans certificat fourni (`TLS_CERT`, `TLS_KEY`), le serveur en génère un, auto-signé, dans `DATA_DIR/tls/`. Ses noms couvrent `localhost`, le nom et les adresses IP de la machine, les hôtes de `PUBLIC_URL` et `PROXY_URL`, et `TLS_SANS`. Dans un conteneur, le nom et les adresses vus par le serveur sont ceux du conteneur : ceux de l'hôte se déclarent dans `TLS_SANS` (par exemple `TLS_SANS=excalibash.lan,192.168.1.20`).

Au premier accès, le navigateur affiche un avertissement. Avant de l'accepter, comparer l'empreinte SHA-256 du certificat (dans les détails de l'avertissement) avec celle des logs :

```bash
docker compose logs excalibash | grep "empreinte"
```

Les commandes d'installation de l'agent épinglent la clé publique de ce certificat (`curl --pinnedpubkey`, `excalibash-agent --pin`) : elles ne dépendent pas de l'avertissement du navigateur. La clé est conservée quand les noms changent, ce qui garde les agents installés valides.

Les tunnels web reposent sur un Service Worker, que les navigateurs refusent sur un certificat non reconnu, même après l'avertissement. Il faut alors installer le certificat de l'instance (`https://<hôte>:6767/certificate.pem`, aussi proposé dans la fenêtre du site) dans le navigateur ou le système, puis recharger.

## Mise en production

En production, Excalibash se sert sur deux noms d'hôte : un pour l'application, un pour les tunnels web. Cette origine séparée empêche les sites ouverts dans un tunnel d'accéder aux clés. Deux possibilités :

- un certificat reconnu passé à l'instance (`TLS_CERT`, `TLS_KEY`), valable pour les deux noms ;
- un reverse proxy qui fait le TLS, avec `TLS=off` sur l'instance (ou un proxy qui joint l'instance en HTTPS).

Exemple avec [Caddy](https://caddyserver.com) :

```
excalibash.example.com {
  reverse_proxy localhost:6767
}
tunnel.example.com {
  reverse_proxy localhost:6768
}
```

```dotenv
PUBLIC_URL=https://excalibash.example.com
PROXY_URL=https://tunnel.example.com
TLS=off
COOKIE_SECURE=true
```

Par défaut, `docker-compose.yml` ne publie les ports 6767 et 6768 que sur `127.0.0.1` : seul le reverse proxy, en 80 et 443, est exposé. Le volume `excalibash-data` contient toutes les données ; son contenu est chiffré.

## Ajouter une machine

Dans **Machines → Ajouter avec un code**, Excalibash affiche une commande courte à lancer sur la machine :

```bash
curl -fsSL https://excalibash.example.com/p/7KQ4FD | sh
```

L'agent génère sa clé sur place et affiche son empreinte, à comparer avec celle d'Excalibash avant de valider. Le code expire après 10 minutes et ne sert qu'une fois.

L'agent est ensuite installé pour démarrer avec la machine : service système en root, service utilisateur avec *linger* sinon, `@reboot` dans la crontab sans systemd.

**Par copier-coller** donne une commande complète, avec une clé générée dans le navigateur.

Supprimer une machine dans **Machines** la déconnecte, et le serveur refuse ensuite son agent. Excalibash donne alors la commande qui retire l'agent de la machine elle-même (service de démarrage, programme, configuration et clés) :

```bash
curl -fsSL https://excalibash.example.com/uninstall.sh | sh
```

Pour un agent installé en root (service système), la lancer avec `sudo sh`.

### Partager une machine

Le bouton **Partager** d'une machine (aussi proposé juste après l'ajout) donne accès à la machine de deux façons :

- **à des personnes** : elles peuvent y ouvrir des shells, des sessions Telnet / SSH et des sites depuis n'importe lequel de leurs tableaux. La machine apparaît dans leur page **Machines**, sous « Partagées avec moi » ;
- **via les tableaux** (activé par défaut sur les nouvelles machines) : quand tu ouvres un shell ou un site sur ta machine dans un tableau partagé, les éditeurs de ce tableau peuvent l'utiliser depuis ce tableau. Le lien tombe quand la machine n'y a plus de session, ou quand on désactive l'option. Les machines ajoutées avant cette version gardent l'option désactivée.

Les sessions ouvertes par quelqu'un tournent avec les droits du compte de l'agent. Retirer un accès ferme ses sessions ; pour une coupure complète (voir [docs/SECURITY.md](docs/SECURITY.md#partage-de-machines)), supprime la machine puis appaire-la de nouveau.

## Sécurité

Le modèle de chiffrement, ce que le serveur voit et ses limites sont décrits dans [docs/SECURITY.md](docs/SECURITY.md). En bref :

- le serveur voit des métadonnées : emails, noms d'affichage, forme de l'arborescence, qui partage avec qui, dates et tailles ;
- comme toute application web chiffrée de bout en bout, Excalibash dépend du JavaScript servi : un serveur compromis pourrait le modifier, d'où l'intérêt de l'héberger soi-même en HTTPS ;
- la lecture seule est appliquée par le serveur, pas par la cryptographie : un lecteur détient la clé du dossier.

Les failles se signalent par une [alerte de sécurité privée](https://github.com/excalibash-fr/excalibash/security/advisories/new), pas dans une issue publique.

## Développement

Prérequis : Node 24+ et Go 1.24+.

```bash
make -C agent dist
(cd server && npm install)
(cd web && npm install && npm run build)
PORT=6767 DATA_DIR=./data-dev node server/src/index.ts
```

`npm run dev` dans `web/` lance Vite avec rechargement à chaud (port 5173, proxifié vers `https://127.0.0.1:6767` ; `BACKEND` change la cible).

```
agent/   agent Go : PTY, chiffrement des flux, tunnels web, reconnexion
server/  Node 24 + TypeScript natif : Express, ws, node:sqlite (relais aveugle)
web/     React + Vite : WebCrypto, tableau de bord, Excalidraw, xterm.js
tests/   scénario de bout en bout
```

```bash
(cd agent && go test ./...)
./tests/run.sh
```

## Remerciements

[Excalidraw](https://github.com/excalidraw/excalidraw) et [xterm.js](https://github.com/xtermjs/xterm.js) (MIT). Idée inspirée de [sshx](https://github.com/ekzhang/sshx) et d'ExcaliDash. Liste complète des composants tiers et de leurs licences : [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

[GNU AGPL-3.0](LICENSE).
