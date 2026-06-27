# Données accessibles via TXLine

Cette app récupère les données TXLine utiles pour suivre, rejouer et analyser un match.

## Calendrier

- Matchs par date ou par fenêtre à venir.
- Compétition, fixture ID, équipes, heure de début.
- Filtre par compétition ou recherche texte.

Endpoints :

- `GET /api/fixtures`
- `GET /api/fixtures/upcoming`

## Scores et événements

- Score live, historique et snapshots.
- Séquence complète des actions d'un fixture.
- Replay chronologique des événements.
- Source utilisée : `historical`, `updates` ou `snapshot`.

Endpoints :

- `GET /api/scores/{fixture_id}/historical`
- `GET /api/scores/{fixture_id}/updates`
- `GET /api/scores/{fixture_id}/snapshot`
- `GET /api/scores/{fixture_id}/timeline`

## Actions de match

L'API peut exposer notamment :

- buts
- tirs
- penalties
- coups francs
- corners
- touches
- cartons jaunes / rouges
- VAR
- remplacements
- blessures
- temps additionnel
- actions annulées ou amendées

Chaque action peut contenir : minute, équipe, possession, type d'action, résultat, confirmation, joueur concerné et détails bruts TXLine.

## Possession et pression

On récupère les changements de possession et les niveaux d'intensité indiqués par TXLine :

- `safe_possession`
- `attack_possession`
- `danger_possession`
- `high_danger_possession`

Important : TXLine ne fournit pas de coordonnées précises `x/y` de la balle dans les données utilisées ici.

## Joueurs et compositions

Quand TXLine les fournit :

- titulaires
- remplaçants
- numéros
- noms des joueurs
- joueurs entrants / sortants
- buteur ou joueur lié à une action

## Contexte match

Selon les fixtures, on peut aussi récupérer :

- météo
- état du terrain
- type de venue
- couleurs de maillots
- statut du match
- horloge
- kickoff
- couverture TXLine

## Stats

Les stats disponibles dépendent du match et de la couverture TXLine. L'app conserve les champs bruts et extrait les plus utiles :

- buts
- corners
- cartons
- score par période quand disponible
- `Stats`, `Parti1State`, `Parti2State`, `PossibleEvent`

## Données brutes et export

Pour ne rien perdre, l'endpoint complet renvoie :

- `rawRecords` : tous les records TXLine bruts
- `timeline` : événements normalisés
- `details` : résumé match
- `inventory` : inventaire des champs disponibles
- `latestState` : dernier état connu
- `sourceCounts` : volumes par source

Endpoint :

- `GET /api/scores/{fixture_id}/full?include_raw=true`

Dans l'interface, le bloc **Données max** permet de charger ce paquet et de l'exporter en JSON.
