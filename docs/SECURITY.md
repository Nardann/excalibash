# Excalibash — modèle de sécurité (chiffrement de bout en bout)

Objectif : **le serveur, l'hébergeur et les administrateurs ne peuvent ni lire ni modifier
silencieusement** les tableaux, noms, aperçus, images, curseurs et terminaux. Ils ne peuvent
pas non plus se faire passer pour un utilisateur afin d'obtenir ses données.

## Ce que le serveur voit (métadonnées)

Emails et noms d'affichage, la forme de l'arbre (qui est parent de qui, qui a accès à quoi),
les dates (dont la dernière activité de chaque compte), pour chaque session ouverte la date de dernière
utilisation, un libellé approximatif du navigateur et du système (« Firefox · Linux », 40 caractères au plus,
déduit de l'User-Agent qui n'est jamais conservé tel quel) et un préfixe d'adresse IP (IPv4 en /24 « 192.168.1.x »,
IPv6 en /48), les tailles, le nombre d'éléments, les ids
et versions des éléments, qui est connecté, les dimensions et le rythme d'activité des terminaux. **Il ne voit jamais** : les noms de
dossiers et de tableaux, les dessins, les images, les aperçus, les positions de curseur, ni ce qui
est tapé ou affiché dans les terminaux.

Limite propre à toute application web chiffrée de bout en bout : le serveur fournit le JavaScript. Un hébergeur malveillant
qui modifie le code servi peut tout compromettre. On réduit la surface (CSP stricte, aucune
dépendance chargée d'un CDN), mais seul un code auditable et un hébergeur de confiance
règlent ce point.

## Primitives (WebCrypto côté navigateur, stdlib côté Go)

Encodage binaire → texte : **base64url sans padding** partout.
AAD = chaîne UTF-8 qui lie chaque chiffré à son emplacement : le serveur ne peut pas déplacer
un chiffré d'un objet à un autre.

| Nom | Format |
|---|---|
| `box(K, pt, aad)` | `0x01 ‖ iv(12) ‖ AES-256-GCM(K, iv, pt, aad)` — iv aléatoire |
| `seal(pub, pt, aad)` | `0x02 ‖ ephPub(32) ‖ iv(12) ‖ AES-256-GCM(k, iv, pt, aad)` où `k = HKDF-SHA256(ikm = X25519(ephPriv, pub), salt = ephPub ‖ pub, info = "excalibash/seal/v1", 32)` |
| Clé symétrique | 32 octets aléatoires |
| Clé asymétrique | X25519, publique = 32 octets bruts |
| Empreinte | `SHA-256(pub)`, 20 premiers octets en hex majuscule par groupes de 4 : `AB12 CD34 …` |

## Comptes

- Dérivation : `Argon2id(password, salt 16 o, m = 64 Mio, t = 3, p = 1) → 32 o`, puis HKDF :
  `authKey` (`info = "excalibash/auth"`) et `masterKey` (`info = "excalibash/master"`).
- Le serveur ne reçoit que `authKey` et en stocke `scrypt(authKey)`. Il ne voit jamais le mot de passe.
- À l'inscription, le navigateur génère l'id utilisateur, la paire X25519 et une **clé de
  récupération** (32 o, affichée en base32 par groupes). Le serveur stocke :
  - `encPrivateKey = box(masterKey, pkcs8, "eb:priv:<userId>")` ;
  - `recoveryEncPrivateKey = box(HKDF(recovery, "excalibash/recovery-enc"), pkcs8, "eb:priv:<userId>")` ;
  - `recoveryAuthHash = scrypt(HKDF(recovery, "excalibash/recovery-auth"))`.
- `vaultKey = HKDF(X25519(priv, pub), info = "excalibash/vault")` : clé que seul le titulaire
  de la clé privée peut calculer. Elle sert à protéger l'intégrité de ses données à lui
  (clés publiques épinglées de ses machines et de ses contacts).
- `prelogin` renvoie un sel factice déterministe pour un email inconnu (pas d'énumération).
- La clé privée déchiffrée est importée **non extractible** et gardée dans IndexedDB jusqu'à la
  déconnexion. Sa clé publique est **recalculée localement** : celle que fournit le serveur doit
  correspondre, sinon on refuse la connexion. Une clé publique substituée amènerait sinon le client
  à sceller ses propres clés pour quelqu'un d'autre.
- **Premier compte** : il devient administrateur. Pour qu'un inconnu ne le crée pas avant le
  propriétaire d'une instance neuve, il exige un code d'installation affiché dans les logs du
  serveur au démarrage (ou fixé par `SETUP_CODE`).
- **Admin** : il peut inviter, ouvrir ou fermer les inscriptions, suspendre ou supprimer un compte,
  nommer d'autres admins, et voir les métadonnées ci-dessus (stockage, machines, dernière
  activité). Il **ne peut pas** changer le mot de passe d'un autre, se connecter à sa place,
  ni s'ajouter à un partage. L'API ne le permet pas, et même en trafiquant la base il n'obtiendrait
  que des chiffrés.
- Mot de passe perdu : la clé de récupération permet d'en redéfinir un. Sans elle, les données sont perdues.
- Déconnexion, changement de mot de passe, récupération ou suppression du compte : les sessions
  concernées sont supprimées et les connexions temps réel ouvertes sont coupées.
- **Sessions actives** (« Mon compte → Appareils connectés ») : chaque session stocke sa date de création, sa
  dernière utilisation (écrite au plus une fois toutes les 5 minutes), un libellé approximatif navigateur / système
  et un préfixe d'IP grossier. Ni l'User-Agent brut ni l'adresse IP complète ne sont enregistrés (celle-ci figure
  seulement dans l'email de nouvelle connexion, si tu l'actives). Chaque session a un identifiant public aléatoire,
  distinct du hachage du jeton. Le titulaire peut déconnecter un appareil ou tous les autres : la session est supprimée
  et ses connexions temps réel sont coupées aussitôt. Personne d'autre, administrateurs compris, ne peut lister ni
  révoquer les sessions d'un compte par l'API.
- **Inscription** : quand un serveur SMTP est configuré, l'email est vérifié par un code à 6 chiffres
  (stocké haché, 5 essais, 15 min). Une preuve de travail calculée par le navigateur, un champ piège
  et un plafond horaire limitent les inscriptions automatiques. Ces mesures protègent le serveur,
  pas les données : elles n'ont aucun rôle dans le chiffrement.
- **Notifications par email** : seuls les partages sont annoncés par défaut, chacun choisit lesquelles recevoir. Les noms des
  tableaux et dossiers étant chiffrés, un email dit seulement le type d'élément (« un tableau »), le nom
  affiché de la personne à l'origine et, pour une connexion, la date et l'adresse IP.

## Arbre de dossiers et partages

Chaque dossier et chaque tableau a sa propre clé `K` et un `id` généré par le client.

- `encName = box(K_item, nom, "eb:name:<id>")`
- Enfant d'un dossier : `keyWrap = box(K_parent, K_item, "eb:wrap:<id>:<parentId>")`
- Élément à la racine ou partagé : une **grant** `wrappedKey = seal(pub_user, K_item, "eb:grant:<id>:<userId>")`,
  avec un rôle `owner | editor | viewer`. Le propriétaire a une grant `owner` sur chacun de ses éléments racine.
- Accès à un élément = une grant sur lui ou sur un ancêtre. On déroule la chaîne de `keyWrap`
  vers le bas : **les sous-dossiers d'un dossier partagé sont donc partagés aussi**. Le rôle effectif
  est le plus fort trouvé sur le chemin.
- Seul le propriétaire (`owner_id`) partage ou révoque. On ne peut déplacer un élément qu'entre
  éléments du même propriétaire ; le client re-wrappe alors la clé sous celle du nouveau parent.
- **Révocation = rotation** : le navigateur du propriétaire génère de nouvelles clés pour tout le
  sous-arbre, re-chiffre noms, wraps, éléments, fichiers, aperçus et clés de terminaux, puis
  ré-émet les grants des membres restants. Le serveur applique le tout en une transaction et
  incrémente `key_epoch`. Les écritures portant un ancien epoch sont refusées.
  - Les terminaux qui tournent sur les machines du propriétaire reçoivent une nouvelle clé (`rekey`).
  - Les autres terminaux du sous-arbre sont fermés : le propriétaire ne peut pas authentifier la
    clé d'une machine qui ne lui appartient pas.
- Épinglage (TOFU) : la clé publique de chaque destinataire est épinglée dans le coffre de
  l'utilisateur (`box(vaultKey, …)`), **par id de compte et par email**. On détecte ainsi un compte
  supprimé puis recréé avec la même adresse.
  - Une clé qui ne correspond plus à l'épingle est refusée, sauf vérification explicite de l'empreinte.
  - Lors d'une rotation, les nouvelles clés ne vont **qu'aux membres épinglés** : un membre ou une
    clé glissés par le serveur font échouer la rotation au lieu de recevoir les clés.
  - Une personne trouvée **par son nom** n'a pas d'email affiché : l'épingle se fait alors par id de
    compte seul (l'email n'est ajouté que quand on le connaît).
- **Recherche de personnes** : par défaut un compte est trouvable par son nom (exact ou début du nom,
  2 caractères minimum, 8 résultats, limitée en débit) et pas par son email ; chacun peut changer
  l'un et l'autre dans « Mon compte ». La recherche renvoie nom, couleur et clé publique, jamais
  l'email d'une personne qui ne s'est pas rendue trouvable par email (sauf à ceux qui partagent déjà
  avec elle). Les noms sont donc énumérables par un compte connecté ; le serveur les connaissait déjà.
  Un email non trouvable répond comme un compte inexistant.
- **Donner un élément** (`POST /items/:id/transfer`) : le propriétaire d'un élément à sa racine peut
  le donner à quelqu'un qui y a déjà un accès direct. `owner_id` change pour tout le sous-arbre, le
  destinataire devient `owner` (sa grant, scellée pour lui, reste valable) et l'ancien propriétaire
  `editor`. Aucune clé ne change : l'ancien propriétaire garde donc ce qu'il a déjà pu lire, comme
  un membre dont l'accès serait retiré sans rotation ; le nouveau propriétaire peut faire pivoter
  les clés (en retirant l'ancien) s'il le veut. Les terminaux et tunnels restent liés aux machines
  de leurs propriétaires.

## Contenu d'un tableau (clé `K_b`)

| Donnée | AAD |
|---|---|
| Élément : `{id, v, n, c}` avec `c = box(K_b, JSON(element))` | `eb:el:<boardId>:<id>:<version>:<versionNonce>` |
| Fichier (image) | `eb:file:<boardId>:<fileId>` |
| Aperçu SVG | `eb:preview:<boardId>` |
| Curseur | `eb:ptr:<boardId>` |
| Clé de terminal pour le tableau | `eb:termkey:<boardId>:<termId>` |

`id`, `version` et `versionNonce` restent en clair : c'est ce qui permet au serveur de fusionner
les modifications concurrentes (règle Excalidraw) sans rien lire du contenu.

## Machines et terminaux

- Ajout d'une machine : **le navigateur** génère la clé privée X25519 de l'agent (32 octets). Elle
  n'apparaît que dans la commande d'installation affichée à l'utilisateur.
  - Clé d'autorisation : `machineAuth = HKDF(priv, "excalibash/machine-auth")`. Seuls le propriétaire,
    l'agent et les personnes avec qui il partage la machine la connaissent (voir « Partage de machines »).
  - Le serveur ne reçoit que des chiffrés du coffre, qu'il ne peut pas forger : la clé publique
    (`eb:machine:<id>`, pour l'empreinte), `machineAuth` (`eb:machine-auth:<id>`) et le nom.
  - Le jeton d'authentification à `/agent` est distinct et ne sert qu'à la connexion.
- **Appairage par code** (sans copier-coller) :
  - le serveur crée un rendez-vous de 10 minutes, à usage unique, avec un code de 6 caractères ;
  - l'agent **génère sa propre paire X25519 sur la machine** et dépose sa clé publique ;
  - le navigateur du propriétaire affiche l'empreinte de cette clé, que l'humain compare avec celle affichée par la machine ;
  - après validation seulement, le navigateur scelle un `machineAuth` aléatoire pour cette clé (`seal(agentPub, machineAuth, "eb:pair:<code>")`), et l'agent l'enregistre dans `~/.config/excalibash/agent.json` (0600) ;
  - un serveur qui substituerait sa propre clé ferait apparaître une empreinte différente de celle de l'écran de la machine. Deviner un code n'apporte rien d'autre que ce même risque : le dépôt de clé est limité en débit, et un code n'accepte qu'une seule machine.
- Chaque terminal a une clé `K_t` générée par le navigateur **de qui l'ouvre**, qui doit détenir `machineAuth` (le propriétaire de la machine, ou une personne à qui il l'a partagée).
  Le serveur stocke :
  - `keyForBoard = box(K_b, K_t, "eb:termkey:<boardId>:<termId>")` ;
  - `keyForAgent = box(machineAuth, K_t, "eb:term:<termId>")`. Une clé simplement scellée avec la clé
    publique de l'agent est refusée : connaître la clé publique ne suffit donc pas pour lui faire
    ouvrir un shell.
- Agent ⇄ serveur :
  - `open {id, cols, rows, key}` : `key = keyForAgent` (aussi renvoyé tel quel lors d'un redémarrage) ;
  - `rekey {id, key}` ;
  - `output {id, gen, seq, d}` avec `d = box(K_t, octets, "eb:term-out:<id>:<gen>:<seq>")`.
    `gen` (chaîne aléatoire) change à chaque lancement de PTY ou rekey ; `seq` part de 1 et croît
    strictement. Le navigateur rejette `seq ≤ dernier` pour une même `gen`. L'agent annonce chaque
    nouvelle `gen` par une trame vide authentifiée, envoyée au lancement, au rekey et à la reconnexion.
  - `input {id, s, k, ts, d}` avec `d = box(K_t, octets, "eb:term-in:<id>:<gen>:<s>:<k>:<ts>")`.
    Une frappe capturée ne peut donc pas être rejouée dans un shell relancé ou re-clé.
    `s` = id aléatoire d'un émetteur (onglet), `k` = compteur strictement croissant par émetteur,
    `ts` = horodatage en ms. L'agent rejette `|now − ts| > 5 min` et `k ≤ dernier k vu pour s`.
    Le serveur ne peut donc pas rejouer des frappes.
- Le serveur garde l'historique de sortie **chiffré** (morceaux `{gen, seq, d}`) pour le rejouer
  aux nouveaux arrivants.
- Les lecteurs (rôle viewer) reçoivent la sortie mais le serveur rejette leurs entrées.
  Ils ont la clé : c'est une restriction d'accès, pas une garantie cryptographique.
- Toute machine est un agent avec ses propres clés : le serveur n'exécute aucun shell lui-même.
- L'agent choisit seul le shell et le répertoire de départ (ceux de son compte) : le serveur ne
  peut pas lui faire lancer un autre programme.

## Sessions Telnet, SSH et TCP brut

- Une session vers un équipement (switch, routeur, PC joignable depuis la machine) est un terminal
  comme les autres : même clé de terminal, mêmes trames chiffrées, même anti-rejeu. Seule la source
  change : une connexion réseau ouverte par l'agent au lieu d'un shell local.
- La cible (`kind`, hôte, port, utilisateur, options) est scellée avec la clé du terminal sous
  `machineAuth` (AAD `eb:term:<id>`) : seuls ceux qui détiennent cette clé (propriétaire, personnes à qui la
  machine est partagée) peuvent la fixer, et le serveur ne peut ni la lire ni la remplacer. Une nouvelle clé (rotation) ne change jamais la cible.
- L'agent valide chaque champ (hôte, port, utilisateur) avant de se connecter ; tout champ invalide
  ferme la session.
- **Telnet et TCP brut** ne sont chiffrés que jusqu'à l'agent : entre la machine et l'équipement, le
  trafic circule en clair sur le réseau local, comme avec n'importe quel client Telnet.
- **SSH** : client intégré à l'agent. La clé d'hôte est épinglée à la première connexion dans
  `known_hosts`, à côté de la configuration de l'agent ; une clé différente bloque la connexion.
  La vérification peut être désactivée par session (option avancée, déconseillée). Les mots de passe
  se tapent dans le terminal : ils voyagent chiffrés jusqu'à l'agent et ne sont jamais stockés.
- L'option « Équipement ancien » n'ajoute des algorithmes faibles (`diffie-hellman-group1-sha1`,
  `ssh-rsa`, `ssh-dss`, CBC, `hmac-sha1`) qu'à la session qui la demande.

## Tunnels web

- Le navigateur de qui ouvre le tunnel (propriétaire de la machine ou personne à qui elle est partagée) génère `K_w`. Il dépose `box(machineAuth, {k: K_w, url, insecure}, "eb:web:<id>")`
  pour l'agent : la **cible est scellée avec la clé**, et le serveur ne peut ni la lire ni la changer
  (pas de redirection vers un autre port ou un autre hôte). Il dépose aussi `box(K_b, K_w, "eb:webkey:…")` pour les membres
  du tableau, et la cible chiffrée dans le libellé.
- Le site s'exécute sur une **origine séparée** (`PROXY_URL`, port 6768 par défaut). Il n'a donc aucun accès au
  stockage d'Excalibash (clés de compte). La clé du tunnel n'est remise par `postMessage` qu'à l'iframe ou à l'onglet
  ouvert par Excalibash pour ce tunnel. Elle n'apparaît jamais dans une URL.
- Un Service Worker de cette origine chiffre chaque requête : `box(K_w, {m, p, h, b}, "eb:http-req:<id>:<rid>:<ts>")`.
  L'agent rejette les horodatages à plus de 5 min et les `rid` déjà vus, déchiffre, appelle la cible et renvoie
  `box(K_w, {s, h, b}, "eb:http-res:<id>:<rid>")`. Le serveur ne relaie que des chiffrés.
- **WebSocket** : le Service Worker ne voit pas les connexions WebSocket, donc il ajoute aux pages HTML du site un script
  (`/eb-proxy/ws-shim.js`) qui remplace `WebSocket` pour les adresses du site (l'origine proxy ou la cible). Chaque socket du
  site ouvre une socket vers `/eb-proxy/ws/<id>` sur l'origine proxy, que le serveur apparie à l'agent sans la lire :
  - ouverture : `box(K_w, {p, protos, cookie}, "eb:ws-open:<id>:<sid>:<ts>")`, avec les mêmes contrôles que pour une requête
    (horodatage à moins de 5 min, `sid` jamais vu). L'agent ouvre la socket vers la **cible scellée** ; l'`Origin` est celle de
    la cible et l'en-tête Host du navigateur est ignoré. La réponse est `box(K_w, {ok, proto}, "eb:ws-ack:<id>:<sid>")` ;
  - messages : `box(K_w, type ‖ données, "eb:ws-msg:<id>:<sid>:<c2a|a2c>:<n>")`, avec un compteur par sens. Le serveur ne peut
    ni rejouer, ni réordonner, ni supprimer, ni injecter un message : le premier écart ferme la socket ;
  - fermeture : scellée aussi (`eb:ws-close:…`, avec le dernier compteur) et porte le code du site. Une fermeture sans
    authentification (serveur, réseau, erreur d'intégrité) apparaît comme une fermeture anormale (1006) ;
  - limites : 32 sockets par tunnel côté agent, 256 au total, 64 par tunnel côté serveur, messages de 16 Mo au plus. Fermer,
    renouveler la clé d'un tunnel ou perdre la machine coupe ses sockets ;
  - le serveur voit les tailles et les moments des messages, pas leur contenu ni la cible. Les sockets vers d'autres hôtes
    que le site ne passent pas par le tunnel. Une page dont la CSP interdit le script du shim garde les WebSocket natives, qui
    échouent. Les WebSocket ouvertes depuis un Worker ne sont pas prises en charge.
- Options avancées, scellées avec la cible : `hostHeader` (en-tête Host et nom SNI envoyés à la cible, pour les
  hôtes virtuels) et `legacyTls` (TLS 1.0/1.1 et suites anciennes, pour les interfaces web de vieux équipements).
  L'en-tête Host envoyé par le navigateur est toujours ignoré.
- Le Service Worker tient un jar de cookies par tunnel. Les en-têtes `Set-Cookie` ne deviennent jamais de vrais cookies du navigateur.
- Seul Excalibash peut intégrer un site tunnelisé en iframe (`frame-ancestors`). L'iframe ne peut pas faire naviguer
  l'onglet Excalibash, et l'onglet plein écran perd `window.opener`.
- La révocation renouvelle aussi les clés des tunnels qui passent par les machines du propriétaire.
- Limites actuelles :
  - pas de streaming dans le site tunnelisé (les réponses HTTP font au plus 48 Mo, d'où pas de SSE ; les WebSocket, elles, passent) ;
  - les sites ouverts partagent l'origine proxy entre eux, mais pas avec Excalibash (voir les
    risques résiduels) ;
  - l'origine proxy n'a pas de session : une requête vers un tunnel inconnu est refusée avant que
    son corps soit lu ;
  - en local, `localhost:6767` et `localhost:6768` partagent leurs cookies (les cookies ne dépendent pas du port). Le cookie
    de session est `HttpOnly` et `SameSite=Strict`, et l'API exige du JSON, ce qui bloque le CSRF. En production, un nom
    d'hôte distinct reste préférable.

## État des câbles (ping)

- Une IP saisie au bout d'un câble est testée depuis la machine à l'autre bout, seulement si l'utilisateur
  qui regarde le tableau peut utiliser cette machine (la sienne, ou une machine partagée avec lui, voir « Partage de machines »). Son navigateur dépose
  `box(machineAuth, {targets}, "eb:probe:<rid>:<ts>")` via `POST /api/machines/<id>/probe`. Le serveur vérifie
  que l'utilisateur a accès à la machine, limite à une sonde en cours et une toutes les 2 s par machine, et relaie
  le chiffré à l'agent.
- L'agent rejette les horodatages à plus de 5 min, les `rid` déjà vus et tout ce qui n'est pas scellé sous
  `machineAuth`. Il ne teste que de vraies adresses IP (au plus 32), une à une, avec le `ping` du système, l'adresse
  étant passée comme simple argument (jamais via un shell). Il répond `box(machineAuth, {r}, "eb:probe-res:<rid>")`.
- Le serveur ne voit ni les adresses ni les résultats, et ne peut pas faire sonder quoi que ce soit : il ne
  détient pas `machineAuth`. Les résultats restent dans le navigateur de qui a demandé la sonde et ne sont pas
  partagés avec les autres membres du tableau.
- La machine mémorisée par une icône est une donnée du tableau, que tout éditeur peut écrire. Elle n'est retenue
  que si cette machine a un terminal ou un tunnel ouvert sur ce tableau, d'après le serveur. Un éditeur ne peut
  donc pas faire envoyer des pings depuis la machine d'un autre en trafiquant une icône.

## Partage de machines

Ouvrir un shell, un tunnel ou une sonde exige `machineAuth` : partager une machine revient à confier cette clé.

- **Partage direct** : le navigateur du propriétaire scelle `{auth: machineAuth, name, pub}` pour la clé publique du
  destinataire (`seal(pub_user, …, "eb:machine-share:<machineId>")`). Cette clé est vérifiée contre l'épingle du coffre
  (TOFU), exactement comme pour un partage de tableau : une clé changée est refusée sauf vérification de l'empreinte. Le
  destinataire peut alors utiliser la machine depuis n'importe quel tableau dont il est éditeur.
- **Partage via les tableaux** (option par machine, activée par défaut à la création, désactivée pour les machines
  antérieures) : quand le propriétaire ouvre lui-même un shell ou un site sur une de ses machines dans un tableau
  qu'il peut modifier, son navigateur dépose `box(K_b, {auth, name, pub}, "eb:machine-link:<boardId>:<machineId>")`.
  Les membres du tableau peuvent le déchiffrer avec la clé du tableau.
  - Le lien n'est **créé que sur une action du propriétaire** (ouvrir une session). Ni une icône (donnée du tableau que
    tout éditeur peut écrire), ni la liste des sessions (fournie par le serveur), ni une session ouverte par quelqu'un
    à qui la machine est partagée directement ne suffisent : personne ne peut faire remettre la machine aux membres
    d'un tableau à la place du propriétaire. Après une rotation des clés, le navigateur ne recrée que les liens qu'il
    avait créés lui-même (mémorisés localement).
  - Le lien est retiré quand la machine n'a plus de session sur le tableau.
  - Le serveur n'accepte un lien que du propriétaire, éditeur du tableau, avec l'option activée, hors corbeille ; il ne
    le sert qu'aux éditeurs, et plus du tout si le propriétaire perd ses droits d'édition ou si le tableau part à la corbeille.
- **Contrôle du serveur** : `term.create`, `web.create` et la sonde ne sont acceptés que pour le propriétaire, un
  destinataire direct, ou (depuis ce tableau seulement) un éditeur du tableau lié, tant que le propriétaire en est encore
  éditeur, que l'option est activée et que le tableau n'est pas à la corbeille. Le serveur ne sert pas les liens aux
  lecteurs, mais ils ont la clé du tableau : comme pour la lecture seule, c'est une restriction du serveur, pas une
  garantie cryptographique.
- **Retrait** : retirer une personne, retirer un lien, désactiver l'option, changer un rôle, mettre le tableau à la
  corbeille, le donner ou renouveler ses clés ferme les shells et les sites ouverts par ceux qui perdent l'accès. Une rotation des clés d'un tableau supprime ses liens (ils étaient chiffrés sous l'ancienne
  clé) ; ses terminaux sont rafraîchis par quiconque détient `machineAuth` en propre (propriétaire ou partage direct).
- Le serveur voit qui a accès à quelle machine et à quels tableaux elle est liée. Il ne voit ni la clé, ni le nom de la
  machine.
- **Limite** : `machineAuth` ne change pas quand on retire un accès. Quelqu'un qui l'a reçue et qui s'entendrait avec
  le serveur pourrait encore ouvrir des sessions ; le serveur seul ne le peut pas. Pour une coupure complète, supprimer
  la machine et l'appairer de nouveau (nouvelle clé).
- **Origine non authentifiée** : comme pour les dossiers, un partage direct est scellé de façon anonyme. Un serveur
  malveillant pourrait présenter à quelqu'un une « machine partagée par Alice » qui est en fait la sienne, et lire ce
  qui y serait tapé. Un lien de tableau, lui, est chiffré sous la clé du tableau, que le serveur n'a pas.

## Client MCP

Le client MCP (`excalibash-mcp.mjs`, voir [MCP.md](MCP.md)) est un programme local qui ouvre une session
comme le navigateur : même connexion (`prelogin`, `authKey`), même déchiffrement de la clé privée, même
vérification de la clé publique, mêmes websockets de tableau et mêmes trames chiffrées.

- **Le serveur ne voit rien de nouveau** : c'est une session de plus du compte (visible comme un pair
  du tableau quand elle est ouverte). Aucun contenu en clair, aucune nouvelle clé, aucun nouveau point d'API.
- Le déchiffrement a lieu sur la machine de l'utilisateur. Le résultat des outils est ensuite remis au
  client MCP choisi par l'utilisateur, et à travers lui à son modèle : ce que l'utilisateur lui confie
  sort donc du périmètre du chiffrement de bout en bout, par son choix.
- Le fichier `~/.config/excalibash/mcp.json` (0600, dossier 0700, refusé s'il est lisible par d'autres)
  contient le cookie de session et la clé privée : même modèle de confiance que le trousseau du navigateur
  ou `agent.json`. La session se révoque (déconnexion, changement de mot de passe) comme les autres.
- Lecture seule par défaut. La saisie dans un terminal (`--autoriser-saisie`) et l'ajout de notes
  (`--autoriser-edition`) sont des options explicites, journalisées sans leur contenu. Les droits sont ceux
  du compte : le serveur refuse toujours la saisie à un lecteur.
- Les sorties de terminal et le contenu des tableaux sont des données non fiables (injection de prompt) ;
  `--tableaux` limite les outils à des tableaux précis.
- Le certificat d'une instance auto-signée se fait confiance via `NODE_EXTRA_CA_CERTS`, jamais en
  désactivant la vérification TLS.

## HTTPS et certificat auto-signé

- Par défaut (`TLS=auto`), les deux ports (application et tunnels) parlent HTTPS. Un certificat
  fourni (`TLS_CERT`, `TLS_KEY`) est utilisé tel quel. Sinon, le serveur génère au premier démarrage
  un certificat auto-signé dans `DATA_DIR/tls/` : `cert.pem`, `key.pem` (0600) et `sans.json`.
  - ECDSA P-256, signature SHA-256, CN `Excalibash`, valable 10 ans, `CA:FALSE`,
    `digitalSignature`, `serverAuth`. Générateur en TypeScript sur `node:crypto`, sans dépendance
    ni appel à `openssl`.
  - Noms (SAN) : `localhost`, `127.0.0.1`, `::1`, le nom de la machine, ses adresses IP non internes
    (hors lien local IPv6), les hôtes de `PUBLIC_URL` et `PROXY_URL`, et `TLS_SANS`.
  - Si cette liste change, ou à moins de 30 jours de l'expiration, le certificat est réémis **avec
    la même clé** : l'épingle ne change pas et les agents déjà installés continuent de se connecter.
    Supprimer `key.pem` force une nouvelle clé (et donc une nouvelle épingle).
  - Au démarrage, les logs affichent l'empreinte SHA-256 du certificat (à comparer avec celle que
    montre le navigateur avant d'accepter l'avertissement) et l'épingle.
- **Épingle** : `sha256//<base64 du SHA-256 de la SubjectPublicKeyInfo>`, le format de
  `curl --pinnedpubkey`. `/api/config` la publie (`tls.pin`), mais elle n'a de valeur que si la page
  elle-même a été obtenue sur une connexion dont l'empreinte a été vérifiée.
- **Scripts et agents** : avec le certificat auto-signé, les commandes affichées, `/install.sh` et
  `/p/<code>` utilisent `curl -k --pinnedpubkey` (`-k` ne fait qu'ignorer l'autorité de
  certification ; la clé publique reste vérifiée) et lancent l'agent avec `--pin`. L'agent remplace
  alors la vérification habituelle par la comparaison de la clé publique du certificat présenté
  (ni chaîne ni nom d'hôte), pour la websocket `/agent` comme pour l'appairage, et enregistre
  l'épingle dans sa configuration. `wget` ne sait pas épingler : sans curl, le script s'arrête.
- L'épingle n'est pas annoncée quand la requête porte `X-Forwarded-For` ou `Forwarded` : derrière
  un reverse proxy, le client voit le certificat du proxy, pas celui de l'instance.
- **HTTP clair** : sur le même port, une requête HTTP reçoit une redirection 308 vers HTTPS. Seule
  exception : l'ouverture de la websocket `/agent`, servie normalement pour les agents appairés en
  `http://`. Leurs échanges restent chiffrés de bout en bout ; seul le jeton de connexion passe en
  clair, comme avant.
- **Tunnels web** : un navigateur refuse d'enregistrer un Service Worker servi avec un certificat
  qu'il ne reconnaît pas, même après avoir accepté l'avertissement. La page du tunnel l'explique et
  propose `/certificate.pem` à installer dans le navigateur ou le système.
- `TLS=off` rend le comportement antérieur (HTTP seul), pour un reverse proxy qui fait le TLS.

## Risques résiduels (assumés, documentés)

- **Code servi** : le serveur fournit le JavaScript et le binaire de l'agent (`/install.sh`). Un
  hébergeur malveillant peut servir une version piégée. Parade : héberger soi-même, construire
  l'agent depuis les sources, comparer les empreintes.
- **Origine d'un partage non authentifiée** : un serveur malveillant peut présenter à quelqu'un un dossier
  « partagé par Alice » qu'il a créé lui-même. Il ne lit rien de ce qui existe déjà, mais pourrait
  lire ce qui y serait déposé ensuite.
- **Disponibilité et retour en arrière** : le serveur peut refuser, retarder ou resservir une
  ancienne version complète d'un élément (chiffré authentique mais périmé).
- **Membres** : les éditeurs peuvent taper dans les terminaux du tableau, avec les droits du
  propriétaire de la machine. Avec le partage via les tableaux, ils peuvent aussi ouvrir de nouvelles
  sessions sur les machines liées au tableau. Les lecteurs ont les clés : la lecture seule est appliquée par le
  serveur, pas par la cryptographie.
- **Suppression d'un compte par un admin** : elle ne déclenche pas de rotation sur les dossiers que
  ce compte partageait.
- **Sites tunnelisés sur une même origine** : tous les tunnels d'un navigateur partagent l'origine
  proxy, où le Service Worker garde leurs clés. Un site piégé, ouvert dans un tunnel (par exemple
  depuis un tableau partagé par quelqu'un d'autre), peut lire les clés des autres tunnels ouverts
  dans ce navigateur et joindre leurs cibles. Parade : n'ouvrir que des sites de confiance, ou un
  profil de navigateur dédié. Une origine par tunnel (sous-domaines) supprimerait ce risque.
- **Quotas** : il n'y a pas de quota de stockage par compte. Avec les inscriptions ouvertes, un
  compte peut remplir le disque ; les inscriptions sur invitation évitent ce risque.
