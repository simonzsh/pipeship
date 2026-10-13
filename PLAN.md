# pipeship — plan

Pipeline de features autonome et environnements de test.

> Nom : `pipeship` (pipeline + « ship », livrer une feature). Libre sur npm le 2026-10-12.
> Origine : discussion du 2026-10-12. Ce document est le point de départ des prochaines sessions.

## 1. Le problème

1. Je demande souvent à Claude, à la main, de revoir, simplifier et nettoyer le code. Je veux que ce travail soit automatique.
2. Un ticket décrit la fonctionnalité, mais il manque souvent des détails. L'agent code alors avec des trous dans sa compréhension.
3. Je travaille sur plusieurs features en même temps. Pour tester chacune, je change de worktree et je lance le serveur à la main. C'est lent et pénible.

## 2. L'objectif

- Je donne un ticket ou une issue, quelle que soit sa source (voir « Source du ticket »).
- Un pipeline d'agents cartographie le code, me pose ses questions, planifie, implémente en parallèle, nettoie le code et crée une stack de PR.
- À la fin, je reçois une URL. L'application tourne déjà sur cette URL. Je teste directement.
- Un dashboard local montre tous les pipelines, leur étape, leurs PR et leur environnement de test.

**Partage des rôles :**
- Les agents gèrent la qualité du code : simplification, doublons, code mort, conventions.
- Je valide le comportement dans l'environnement de test. Je ne relis plus chaque ligne.

## 3. Le pipeline (7 étapes)

### Lancement
- Je lance le pipeline de deux façons :
  - avec la commande `/pipeship <ticket> [mode] [options]` ;
  - en demandant à Claude d'utiliser pipeship par son nom, par exemple « livre ABC-123 avec pipeship ».
- Claude ne lance pas le pipeline pour une demande de feature ordinaire. La description du skill le limite aux demandes qui nomment pipeship.
- Raison : une petite demande ne doit pas lancer des sous-agents par erreur.
- La description inclut les variantes de dictée (« pipe ship », « pipe chip »).
- Limite : Claude décide d'après la description. Ce filtre est très fiable, mais pas absolu comme `disable-model-invocation: true`. Si Claude lance le pipeline par erreur, on revient à la commande seule.

### Source du ticket
- Le pipeline accepte un ticket ou une issue de **n'importe quelle source** : Linear, Notion, GitHub Issues, Jira, une URL, ou du texte libre.
- Le skill ne contient pas de code par source. Claude lit le ticket avec l'outil disponible dans la session : MCP, `gh`, lecture d'URL.
- Si aucun outil ne peut lire la source, Claude me demande de coller le texte du ticket.
- Le skill écrit ensuite le ticket dans un format unique : `ticket.md` dans le dossier du pipeline. Les étapes suivantes lisent seulement ce fichier.
- Exemples : `/pipeship ABC-123`, `/pipeship https://notion.so/…`, `/pipeship "ajouter un filtre par date"`.

### Modes et étapes réglables
- **`full`** (par défaut) : les 7 étapes.
- **`quick`** : cartographie courte, questions bloquantes seulement, implémentation dans un seul worktree, lint/typecheck/tests, une passe `simplify`, une seule PR, environnement de test.
- **Réglage fin** : `--skip <étapes>`, par exemple `--skip questions,stack`. Le skill garde les étapes dont une autre étape a besoin (pas d'environnement de test sans worktree).
- **Changement en cours de route** : je dis « saute la review » dans la session. Le skill met à jour la liste des étapes dans `state.json`. Il relit cette liste avant chaque étape.
- **Proposition de mode** : après la cartographie, Claude peut proposer `quick` pour un petit ticket. Je confirme en un mot.
- Le mode `quick` garde toujours une passe de nettoyage : c'est le problème n°1.

### Les étapes

Chaque étape tourne dans un sous-agent, avec un contexte propre. Chaque étape écrit son résultat dans un fichier. L'étape suivante lit ce fichier.

#### Étape 1 — Cartographie
- Entrée : le ticket.
- L'agent trouve tout le code que le sujet touche : modules, routes, modèles, tests, conventions du repo.
- Sortie : une carte du code concerné, avec les chemins de fichiers.

#### Étape 2 — Questions (pause humaine)
- L'agent compare le ticket et la carte. Il liste ce qui manque ou ce qui est ambigu.
- Il pose **toutes ses questions en un seul lot**. Format : « Aujourd'hui, le code fait X. Question : … »
- Pour chaque question, il propose une **réponse recommandée**. Je valide en un mot ou je corrige.
- Le pipeline passe à l'état `waiting_for_user`. Il ne continue pas sans mes réponses.
- Je réponds dans la session Claude (pas dans le dashboard en V1).
- Sortie : le ticket enrichi avec mes réponses.

#### Étape 3 — Plan, contrats et découpage
- L'agent écrit le plan.
- Il **écrit d'abord les contrats** entre les morceaux : types, routes API, format des données. Sans contrat fixé, le front et le back ne sont pas indépendants.
- Il découpe le travail en **morceaux indépendants**. Chaque morceau peut être codé sans attendre un autre.
- Il ne découpe pas pour rien. Un petit ticket donne un seul morceau. Chaque découpage ajoute un risque d'intégration.
- Il fixe l'ordre de la future stack selon les dépendances : contrat, puis back, puis front.
- Sortie : le plan, les contrats, la liste des morceaux et l'ordre de la stack.

#### Étape 4 — Implémentation en parallèle
- Un sous-agent et un worktree par morceau.
- Tous les morceaux tournent en même temps.
- Chaque agent code contre les contrats de l'étape 3.
- Chaque agent fait passer lint, typecheck et tests sur son morceau.

#### Étape 5 — Review et nettoyage
1. **Review globale** sur l'ensemble des morceaux. Des agents en parallèle ne se voient pas : deux agents peuvent créer le même helper. Seule une review globale trouve ces doublons.
2. **Simplification et review par morceau** : doublons, code mort, conventions du repo, lisibilité.
3. **Règle de sécurité :** après chaque passe qui modifie le code, relancer lint, typecheck et tests. Si un contrôle échoue, corriger ou annuler la passe.
- Briques existantes à réutiliser : skills `simplify` et `code-review`.

#### Étape 6 — Stack de PR
- Une PR par morceau, empilées dans l'ordre fixé à l'étape 3.
- Chaque PR ne montre que son morceau. La relecture reste simple.
- Le sommet de la stack contient toute la feature.

#### Étape 7 — Environnement de test
- L'outil démarre l'application sur la branche du sommet de la stack.
- Il attribue un port libre et une URL du type `http://<feature>.localhost:<port>`.
- Le pipeline passe à l'état `ready`. Le dashboard affiche l'URL.

## 4. Périmètre de la V1

Principe : simple, mais efficace et fonctionnel.

### Dans la V1
- Le skill du pipeline avec les 7 étapes, lancé par `/pipeship`.
- Les modes `full` et `quick`, et l'option `--skip`.
- Toute source de ticket que Claude peut lire, plus le texte collé.
- Un fichier d'état par pipeline, écrit par le skill à chaque étape.
- Un dashboard web local, **une seule page** :
  - la liste des pipelines : ticket, étape en cours, état ;
  - pour chaque pipeline : les liens vers les PR et le lien vers l'environnement de test ;
  - mise à jour en direct, sans recharger la page ;
  - **un seul bouton : « Arrêter le pipeline »**. Il arrête les agents du pipeline et son serveur de test.
- Le démarrage automatique de l'environnement de test à la fin du pipeline.
- Une recette par repo pour démarrer l'application.

### Hors de la V1
- Relancer une étape ou un environnement.
- Répondre aux questions dans le dashboard.
- Une CLI séparée (le dashboard suffit).
- Une base de données isolée par environnement.
- Une limite de RAM automatique.
- Un proxy pour les sous-domaines.

### Risques acceptés en V1
- **Base de données partagée.** Deux features avec des migrations différentes peuvent se gêner.
- **RAM non surveillée.** La machine a 15 Go. Un serveur de dev Next.js prend 1 à 2 Go. J'arrête les pipelines testés pour libérer la mémoire.

## 5. Architecture

```
skill du pipeline (dans Claude Code)
   │  écrit à chaque étape
   ▼
~/.pipeship/pipelines/<id>/state.json   ← source de vérité unique
   ▲  lit (et écrit « stop »)
   │
serveur local (un seul processus)
   ├─ dashboard web sur http://localhost:<port>
   ├─ flux en direct vers le navigateur (Server-Sent Events)
   └─ démarre et arrête les environnements de test
```

Choix et raisons :
- **L'état vit dans des fichiers, dans un dossier central.** Le pipeline fonctionne même si le dashboard est arrêté. Le dossier central permet de voir les pipelines de tous les repos.
- **Le dashboard lit seulement**, sauf pour le bouton « Arrêter ».
- **Pas de proxy.** Les navigateurs résolvent `*.localhost` vers la machine. Les cookies dépendent du nom d'hôte, pas du port. Donc `a.localhost:3001` et `b.localhost:3002` ont des cookies séparés.
- **Stack technique :** TypeScript et Bun, sans framework ni dépendance d'exécution. Une page HTML statique. Confirmé le 2026-10-12.

### Fichier d'état (proposition)

```json
{
  "id": "2026-10-12-abc123",
  "ticket": { "source": "linear | notion | github | url | text | …", "ref": "ABC-123", "url": "…", "title": "…", "file": "ticket.md" },
  "mode": "full | quick",
  "repo": "/chemin/vers/le/repo",
  "status": "running | waiting_for_user | ready | failed | stopped",
  "step": "map | questions | plan | implement | review | stack | preview",
  "steps": [{ "name": "map", "status": "pending | running | done | skipped", "startedAt": "…", "endedAt": "…" }],
  "chunks": [{ "name": "api", "worktree": "…", "branch": "…", "status": "…", "pr": "https://…" }],
  "preview": { "url": "http://abc-123.localhost:3001", "pid": 12345, "port": 3001 },
  "pids": [12340],
  "stopRequested": false,
  "updatedAt": "…"
}
```

### Recette par repo

Décidé le 2026-10-13 : Claude écrit la recette, le programme l'exécute.
- Au premier pipeline dans un repo, l'étape de cartographie lit le projet et écrit un brouillon de recette.
- `pipeship preview --recipe` teste le brouillon. Si l'application démarre, il garde la recette dans `~/.pipeship/recipes/`.
- Les pipelines suivants réutilisent la recette gardée. Je n'écris jamais de recette.
- Un `.pipeship.json` dans le repo reste possible, pour partager une recette avec l'équipe. Il passe avant la recette gardée.
- Raison : un LLM trouve bien comment démarrer un projet. La gestion des processus (port, PID, arrêt) doit rester dans un programme fiable.

Format de la recette :

```json
{
  "install": "bun install",
  "start": "bun run dev",
  "portEnv": "PORT",
  "copyFiles": [".env.local"],
  "readyPath": "/"
}
```

- `copyFiles` : fichiers non versionnés à copier dans le worktree (secrets locaux).
- `readyPath` : chemin appelé pour savoir si le serveur répond.
- Piège connu : certains frameworks refusent les hôtes inconnus en dev (par exemple `allowedDevOrigins` dans Next.js). La recette doit le prévoir.

### Arrêter un pipeline
1. Le dashboard écrit `stopRequested: true` dans le fichier d'état.
2. Le skill lit ce drapeau entre deux étapes et s'arrête.
3. Le serveur tue les processus listés dans `pids` et `preview.pid` (avec `kill <PID>`, jamais `pkill -f`).
4. Le serveur vérifie que les processus sont arrêtés, puis passe l'état à `stopped`.

## 6. Ordre de construction

Chaque jalon est utilisable seul.

1. **Environnement de test.** Lire la recette, préparer le worktree, attribuer un port, démarrer, attendre `readyPath`, afficher l'URL. Tester à la main sur un vrai repo.
2. **Dashboard en lecture seule.** Lire les fichiers d'état, afficher les pipelines et les liens, flux en direct.
3. **Skill du pipeline.** Les 7 étapes, avec écriture du fichier d'état. Commencer par un ticket simple à un seul morceau.
4. **Découpage et parallèle.** Plusieurs morceaux, plusieurs worktrees, stack de PR.
5. **Bouton « Arrêter ».**

## 7. Outils existants à étudier avant de coder

- **Skills superpowers** : `brainstorming`, `writing-plans`, `subagent-driven-development`, `requesting-code-review`. Ils couvrent une grande partie des étapes 1 à 5.
- **Skills de Matt Pocock** : `grilling` correspond à l'étape 2.
- **Conductor** et **Vibe Kanban** : agents en parallèle sur des worktrees, avec interface.
- **`gh stack`** (ou Graphite) : création de stacks de PR.
- **Claude Code** : sous-agents avec `isolation: "worktree"`, et l'outil Workflow pour orchestrer plusieurs agents.

## 8. Questions ouvertes

1. **Forme du pipeline.** Tranché le 2026-10-12 : un skill lancé par `/pipeship`, qui orchestre des sous-agents dans la session Claude. La pause de l'étape 2 se fait dans la conversation. Reste à voir si l'outil Workflow sert pour l'étape 4.
2. **Source du ticket.** Tranché le 2026-10-12 : toute source. Voir « Source du ticket » (section 3).
3. **Lancement du serveur du dashboard.** Tranché le 2026-10-12 : le skill lance `pipeship dashboard` au début de chaque pipeline. La commande ne fait rien si le dashboard tourne déjà.
4. **Distribution publique.** Plugin Claude Code (skill + serveur) ? Package npm pour le serveur ?
5. **Nettoyage.** Tranché le 2026-10-13 : un bouton « Delete » dans le dashboard (et `pipeship delete <id>`). Il supprime les worktrees et le dossier du pipeline, et garde les branches et les PR. Il refuse si un worktree contient des modifications non commitées. Pas d'archivage.

## 9. Prochaine session

V1 écrite le 2026-10-12 : skill, état, environnement de test, dashboard et bouton « Arrêter ».

1. Choisir un vrai repo. Le pipeline écrit lui-même sa recette.
2. Lancer `/pipeship quick` sur un petit ticket. Noter ce qui casse.
3. Lancer un pipeline `full` à plusieurs morceaux.
