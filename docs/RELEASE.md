# Publier une version de l'agent (mise à jour automatique)

Ce document s'adresse à la personne qui **publie** les agents d'une instance. Si tu n'en publies pas (tu utilises
l'image ou le dépôt tels quels, sans clé de signature), les agents ne se mettent pas à jour seuls : la page Machines
propose alors la commande manuelle `update.sh` (voir le [README](../README.md#mettre-à-jour-lagent)).

Principe : la **clé publique** de publication est compilée dans chaque agent. Une mise à jour n'est acceptée que si
elle est signée par la clé privée correspondante, qui reste **hors ligne**. Le serveur ne fait que distribuer les
fichiers signés ; il ne peut ni signer, ni faire exécuter autre chose à un agent (voir
[SECURITY.md](SECURITY.md#mise-à-jour-des-agents)).

## 1. Générer la clé (une seule fois, hors ligne)

Sur une machine de confiance, de préférence non connectée, jamais dans la CI, sur le serveur ni dans le dépôt :

```bash
cd agent
go run ./cmd/excalibash-sign keygen --out ~/excalibash-release.key
# clé privée écrite dans ~/excalibash-release.key (0600) …
# 3q2+7w9bV0kQ1…=            ← clé publique, base64 de 32 octets (sur la sortie standard)
```

- La clé privée (fichier `0600`, jamais écrasé) sert à signer. Sauvegarde-la comme un secret (gestionnaire de mots de
  passe, support chiffré hors ligne) : la perdre oblige à une mise à jour manuelle de tous les agents (voir §6).
- La clé publique n'est pas secrète. Garde-la, elle est donnée à la compilation.

## 2. Compiler les agents avec la clé publique

```bash
export UPDATE_PUBKEY='3q2+7w9bV0kQ1…='
make -C agent dist VERSION=1.2.0 UPDATE_PUBKEY="$UPDATE_PUBKEY"
```

`VERSION` doit être une version de la forme `x.y.z` (un `v` devant est accepté) : l'agent n'accepte qu'une version
**strictement supérieure** à la sienne. Avec Docker :

```bash
docker build --build-arg VERSION=1.2.0 --build-arg UPDATE_PUBKEY="$UPDATE_PUBKEY" -t excalibash .
```

Un agent compilé **sans** `UPDATE_PUBKEY` refuse toute demande de mise à jour (« mise à jour automatique désactivée pour
cet agent (aucune clé de signature intégrée) ») : il reste mettable à jour à la main avec `update.sh`.

## 3. Signer la version

```bash
cd agent
go run ./cmd/excalibash-sign sign --key ~/excalibash-release.key --dist dist --version 1.2.0
```

L'outil (bibliothèque standard seulement) calcule le SHA-256 et la taille de chaque `dist/excalibash-agent-<os>-<arch>`
et écrit, dans `dist/` :

- `agent-manifest.json` : `{"version", "date", "files": {"linux-amd64": {"sha256", "size"}, …}}` ;
- `agent-manifest.json.sig` : signature Ed25519 (base64) des **octets exacts** du manifeste.

Il refuse de signer un binaire qui ne contient pas la version annoncée (binaire oublié d'un build précédent).
Un binaire de plus de 64 Mio est refusé par les agents.

## 4. Publier

Copie dans le dossier servi par le serveur (`AGENT_DIST_DIR`, `agent/dist` par défaut, `/app/agent/dist` dans l'image) les
binaires, `agent-manifest.json` et `agent-manifest.json.sig`, **ensemble**. Le serveur les sert sous `/downloads/`
(liste blanche stricte des noms) et annonce la version dans `GET /api/agent/latest` (`{version, signed}`). Dès lors, la page
Machines propose « Mettre à jour (x → y) » et le tableau « Mettre à jour les agents (N) ».

Les agents vérifient, dans cet ordre : la signature du manifeste avec la clé intégrée, `version` strictement plus récente
que la leur (ni retour en arrière, ni réinstallation), la présence de leur plateforme, la taille puis le SHA-256 du binaire
téléchargé. Au moindre écart, rien n'est installé.

Après une mise à jour, l'agent redémarre sur place (même PID, donc même service systemd, crontab ou lancement manuel).
S'il ne parvient pas à se reconnecter au serveur en 120 s, il remet l'ancien binaire et le signale (« mise à jour
annulée » sur la page Machines).

## 5. Pourquoi le serveur ne peut pas pousser de code

- Il ne détient ni la clé privée ni `machineAuth` : il ne peut ni signer une version ni fabriquer une demande acceptée.
- Un manifeste ou un binaire modifié ne s'authentifie pas (signature, SHA-256, taille).
- Il peut en revanche **ne pas distribuer** une mise à jour (déni de service) ou servir une ancienne version signée **plus
  récente que celle de l'agent** ; il ne peut pas faire revenir un agent en arrière.

## 6. Rotation et compromission de la clé

Une clé n'est valable que pour les agents qui l'ont à la compilation : aucun agent n'accepte une version signée par une
clé qu'il ne connaît pas. **Une nouvelle clé exige donc une mise à jour manuelle** de chaque agent (`update.sh`, qui installe
un binaire compilé avec la nouvelle clé publique), sauf rotation prévue avec une version-relais (ci-dessous).

- **Rotation prévue** : génère une nouvelle paire, publie une dernière version signée avec l'ancienne clé **compilée avec la
  nouvelle clé publique** (les agents l'acceptent automatiquement, elle est signée par l'ancienne), puis signe les suivantes
  avec la nouvelle. Les agents ayant installé cette version ne font plus confiance qu'à la nouvelle clé.
- **Compromission de la clé privée** : une personne qui la détient peut signer une version malveillante que les agents
  accepteront. Retire immédiatement les fichiers `agent-manifest.json*` du dossier servi (les agents n'ont alors rien à
  installer), génère une nouvelle paire, recompile et republie les binaires, et demande de mettre à jour chaque agent à la
  main avec `update.sh` (ou de les réinstaller). Tant qu'un agent porte l'ancienne clé, tout manifeste signé avec elle
  reste accepté s'il est plus récent : ne la réutilise jamais, et incrémente la version.
- **Perte de la clé** : même procédure, sans urgence de sécurité.
