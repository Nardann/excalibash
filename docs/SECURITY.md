# Excalibash — modèle de sécurité (chiffrement de bout en bout)

Objectif : **le serveur, l'hébergeur et les administrateurs ne peuvent ni lire ni modifier
silencieusement** les tableaux, noms, aperçus, images, curseurs et terminaux. Ils ne peuvent
pas non plus se faire passer pour un utilisateur afin d'obtenir ses données.

## Ce que le serveur voit (métadonnées)

Emails et noms d'affichage, la forme de l'arbre (qui est parent de qui, qui a accès à quoi),
les dates (dont la dernière activité de chaque compte), les tailles, le nombre d'éléments, les ids
et versions des éléments, qui est connecté, les dimensions et le rythme d'activité des terminaux. **Il ne voit jamais** : les noms de
dossiers et de tableaux, les dessins, les images, les aperçus, les positions de curseur, ni ce qui
est tapé ou affiché dans les terminaux.

Limite propre à toute appli web E2E : le serveur fournit le JavaScript. Un hébergeur malveillant
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
- **Admin** : il peut inviter, ouvrir ou fermer les inscriptions, suspendre ou supprimer un compte,
  nommer d'autres admins, et voir les métadonnées ci-dessus (stockage, machines, dernière activité). Il **ne peut pas** changer le mot de passe d'un autre, se connecter à sa place,
  ni s'ajouter à un partage. L'API ne le permet pas, et même en trafiquant la base il n'obtiendrait
  que des chiffrés.
- Mot de passe perdu : la clé de récupération permet d'en redéfinir un. Sans elle, les données sont perdues.
- **Inscription** : quand un serveur SMTP est configuré, l'email est vérifié par un code à 6 chiffres
  (stocké haché, 5 essais, 15 min). Une preuve de travail calculée par le navigateur, un champ piège
  et un plafond horaire limitent les inscriptions automatiques. Ces mesures protègent le serveur,
  pas les données : elles n'ont aucun rôle dans le chiffrement.

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
  - Clé d'autorisation : `machineAuth = HKDF(priv, "excalibash/machine-auth")`. Seuls le propriétaire
    et l'agent la connaissent.
  - Le serveur ne reçoit que des chiffrés du coffre, qu'il ne peut pas forger : la clé publique
    (`eb:machine:<id>`, pour l'empreinte), `machineAuth` (`eb:machine-auth:<id>`) et le nom.
  - Le jeton d'authentification à `/agent` est distinct et ne sert qu'à la connexion.
- **Appairage par code** (sans copier-coller) :
  - le serveur crée un rendez-vous de 10 minutes, à usage unique, avec un code de 6 caractères ;
  - l'agent **génère sa propre paire X25519 sur la machine** et dépose sa clé publique ;
  - le navigateur du propriétaire affiche l'empreinte de cette clé, que l'humain compare avec celle affichée par la machine ;
  - après validation seulement, le navigateur scelle un `machineAuth` aléatoire pour cette clé (`seal(agentPub, machineAuth, "eb:pair:<code>")`), et l'agent l'enregistre dans `~/.config/excalibash/agent.json` (0600) ;
  - un serveur qui substituerait sa propre clé ferait apparaître une empreinte différente de celle de l'écran de la machine. Deviner un code n'apporte rien d'autre que ce même risque : le dépôt de clé est limité en débit, et un code n'accepte qu'une seule machine.
- Chaque terminal a une clé `K_t` générée par le navigateur **du propriétaire de la machine**.
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
- Il n'y a plus de machine intégrée : toute machine est un agent avec ses propres clés.

## Tunnels web

- Le navigateur du propriétaire de la machine génère `K_w`. Il dépose `box(machineAuth, {k: K_w, url, insecure}, "eb:web:<id>")`
  pour l'agent : la **cible est scellée avec la clé**, et le serveur ne peut ni la lire ni la changer
  (pas de redirection vers un autre port ou un autre hôte). Il dépose aussi `box(K_b, K_w, "eb:webkey:…")` pour les membres
  du tableau, et la cible chiffrée dans le libellé.
- Le site s'exécute sur une **origine séparée** (`PROXY_URL`, port 6768 par défaut). Il n'a donc aucun accès au
  stockage d'Excalibash (clés de compte). La clé du tunnel n'est remise par `postMessage` qu'à l'iframe ou à l'onglet
  ouvert par Excalibash pour ce tunnel. Elle n'apparaît jamais dans une URL.
- Un Service Worker de cette origine chiffre chaque requête : `box(K_w, {m, p, h, b}, "eb:http-req:<id>:<rid>:<ts>")`.
  L'agent rejette les horodatages à plus de 5 min et les `rid` déjà vus, déchiffre, appelle la cible et renvoie
  `box(K_w, {s, h, b}, "eb:http-res:<id>:<rid>")`. Le serveur ne relaie que des chiffrés.
- Le Service Worker tient un jar de cookies par tunnel. Les en-têtes `Set-Cookie` ne deviennent jamais de vrais cookies du navigateur.
- Seul Excalibash peut intégrer un site tunnelisé en iframe (`frame-ancestors`). L'iframe ne peut pas faire naviguer
  l'onglet Excalibash, et l'onglet plein écran perd `window.opener`.
- La révocation renouvelle aussi les clés des tunnels qui passent par les machines du propriétaire.
- Limites actuelles :
  - pas de WebSocket ni de streaming dans le site tunnelisé (les réponses font au plus 48 Mo) ;
  - les sites ouverts partagent l'origine proxy entre eux, mais pas avec Excalibash ;
  - en local, `localhost:6767` et `localhost:6768` partagent leurs cookies (les cookies ne dépendent pas du port). Le cookie
    de session est `HttpOnly` et `SameSite=Strict`, et l'API exige du JSON, ce qui bloque le CSRF. En production, un nom
    d'hôte distinct reste préférable.

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
  propriétaire de la machine. Les lecteurs ont les clés : la lecture seule est appliquée par le
  serveur, pas par la cryptographie.
- **Suppression d'un compte par un admin** : elle ne déclenche pas de rotation sur les dossiers que
  ce compte partageait.
