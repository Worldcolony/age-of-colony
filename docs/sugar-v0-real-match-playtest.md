# Sugar V0 — playtest sur de vrais matchs TXLine

Date : 2026-07-13

## Résumé

La V0 actuelle n'est pas encore assez lisible ni équilibrée sur une vraie timeline de football.
Le problème principal n'est pas le plafond de `10 Sugar`, mais le rythme de création des marchés :
le moteur actuel produit en moyenne **293 marchés candidats par match** lorsqu'aucune colonie ne prend
position, et encore **148 à 205 marchés** dans les rooms mixtes testées.

La meilleure variante testée conserve plusieurs marchés ouverts, mais limite chaque arrivée à deux
nouveaux marchés et utilise l'horloge du match pour la cadence. Elle produit **17 à 31 marchés sans
entrée** (`20,1` en moyenne) et **16 à 25 marchés dans une room active** sur les huit matchs. Avec des
votes neutres, les trois tempéraments terminent alors près des `20 Sugar` de départ.

## Méthode

- 8 matchs finalisés récupérés par TXLine parmi 20 fixtures récentes inspectées ;
- contrôle strict de la présence d'un record `game_finalised` avec `statusId=100` ;
- 994 à 1 355 événements normalisés par match ;
- équipes : Argentina–Switzerland, Norway–England, Spain–Belgium, France–Morocco,
  Switzerland–Colombia, Argentina–Egypt, USA–Belgium et Portugal–Spain ;
- mêmes timelines, mêmes seeds et vrai `GameHarness` de production pour les règles actuelles et les variantes ;
- seul l'appel LLM payant est remplacé par un votant local déterministe ;
- 8 seeds par match pour la comparaison règles actuelles / variante binaire ;
- 16 seeds par match pour la variante finale de cadence, soit 128 replays par politique de vote.

Commandes principales :

```bash
python3 tools/playtest_real_matches.py \
  --days 30 --matches 8 --scan-limit 20 --runs 8 \
  --policies uniform,accuracy_50,accuracy_60,reward_chaser \
  --rule-sets current,candidate_simple --seed 20260713

python3 tools/playtest_real_matches.py \
  --days 30 --matches 8 --scan-limit 20 --runs 16 \
  --policies uniform,accuracy_50,accuracy_60,reward_chaser \
  --rule-sets candidate_cadence --seed 20260713
```

## 1. Trop de marchés sont créés

Le moteur ouvre actuellement cinq contextes à chaque événement de pression ou de tir. Les cooldowns
sont comptés en nombre d'événements TXLine, pas en temps de match. Avec environ 1 100 événements par
rencontre, les mêmes propositions reviennent beaucoup trop vite.

| Règles | Marchés candidats sans entrée | Marchés vus dans une room active |
| --- | ---: | ---: |
| Actuelles | `293,2 / match` | `148–205 / match` |
| Binaire seulement | `293,2 / match` | `58–107 / match` |
| Binaire + cadence | `20,1 / match` | `16–25 / match` |

La variante seulement binaire semble réduire le volume, mais pour une mauvaise raison : davantage de
colonies entrent, leurs positions restent ouvertes et bloquent la recréation du même contexte. La cadence
devient donc dépendante du comportement des colonies. La troisième variante rend le rythme prévisible avec
des cooldowns basés sur l'horloge du match.

## 2. Les marchés à trois choix punissent les styles actifs

Avec des votes uniformes, donc sans avantage prédictif, la V0 actuelle fait perdre fortement les styles qui
entrent le plus souvent :

| Règles actuelles, vote neutre | Entrée | Sugar final moyen | Offres refusées faute de Sugar |
| --- | ---: | ---: | ---: |
| Prudent | `1,2 %` | `20,14` | `0,0 %` |
| Équilibré | `7,5 %` | `14,78` | `1,1 %` |
| Agressif | `13,6 %` | `11,53` | `16,9 %` |

Avec la variante binaire et la cadence réduite :

| Variante finale, vote neutre | Entrée | Sugar final moyen | p05 du pire match | Offres refusées faute de Sugar |
| --- | ---: | ---: | ---: | ---: |
| Prudent | `11,7 %` | `19,73` | `14,75` | `0,0 %` |
| Équilibré | `51,4 %` | `19,22` | `7,00` | `0,0 %` |
| Agressif | `82,3 %` | `20,37` | `2,75` | `0,9 %` |

Les moyennes redeviennent neutres, tandis que le prudent protège mieux son mauvais scénario et que
l'agressif accepte beaucoup plus de variance. C'est une différence de tempérament compréhensible.

## 3. Un bon signal reste récompensé sans faire exploser l'économie

Quand chaque fourmi reçoit individuellement le bon résultat avec une probabilité de `60 %`, l'agrégation
des 20 votes donne un avantage fort. La V0 actuelle amplifie cet avantage sur près de 200 marchés et fait
monter le Sugar moyen jusqu'à `114,55` pour l'agressif.

| Signal 60 % | Prudent | Équilibré | Agressif |
| --- | ---: | ---: | ---: |
| Règles actuelles — Sugar moyen | `52,23` | `95,67` | `114,55` |
| Variante finale — Sugar moyen | `28,19` | `39,48` | `42,18` |
| Variante finale — part de première place | `0,8 %` | `40,6 %` | `58,6 %` |

La variante finale conserve donc le potentiel offensif de l'agressif sans transformer un match en centaines
de prises de position.

## 4. Récompenses recommandées

### Marchés d'équipe

Utiliser seulement :

- équipe A ;
- équipe B ;
- récompense `+2 / +2` ;
- si l'événement n'arrive pas avant la fin, le marché est **void** et les `2 Sugar` sont libérés.

Cela supprime l'option variable « aucun événement avant la fin », simplifie le vote et rend un choix A/B
aléatoire neutre dès qu'un événement se produit.

### But dans les dix prochaines minutes

Sur les 345 fenêtres observées :

- but : `25,2 %` ;
- aucun but : `74,8 %`.

Le couple actuel `+4 / +1` désavantage légèrement un vote neutre. Le couple `+5 / +1` est presque neutre
sur cet échantillon : l'espérance moyenne d'un choix oui/non uniforme est proche de `0 Sugar` par entrée.
Ce changement doit encore être confirmé sur 30 à 50 matchs uniques avant d'être figé.

### Penalty

Conserver provisoirement `+1` si marqué et passer à `+4` si raté ou arrêté. Avec un risque fixe de `2`, les
deux probabilités de rentabilité s'additionnent exactement à 100 %.

Les données de ce pilote ne permettent pas de mesurer la fréquence réelle des résultats de penalty, car un
bug de détection a été découvert : les événements `penalty_outcome` ouvrent eux-mêmes un nouveau marché,
et les séances de tirs au but amplifient le problème. Il faut exclure les événements de résultat et dédupliquer
la confirmation VAR / l'attribution du penalty avant toute calibration empirique.

## Règles proposées pour la prochaine V0

1. Garder `20` fourmis, `20 Sugar`, un risque fixe de `2`, un plafond réservé de `10` et les seuils
   `14/20`, `12/20`, `11/20`.
2. À une arrivée, ouvrir au maximum deux nouveaux marchés :
   « but dans les 10 minutes » et un contexte secondaire tournant entre prochain but, corner, coup franc
   et carton jaune.
3. Utiliser un cooldown de 10 minutes de match pour « but dans les 10 minutes » et 15 minutes pour le
   contexte secondaire. Plusieurs marchés de contextes différents peuvent rester ouverts simultanément.
4. Passer les marchés d'équipe à A/B `+2 / +2` ; aucun événement avant la fin donne un void.
5. Passer « but dans les 10 minutes » à `+5 / +1`, sous réserve d'une campagne plus large.
6. Passer le penalty à `+1 / +4`, ne jamais ouvrir un marché depuis `penalty_outcome`, et appliquer une
   déduplication temporelle aux confirmations du même penalty.

## Limites

- Huit matchs uniques suffisent pour détecter le problème de cadence, mais pas pour figer toutes les
  probabilités du football.
- Les seeds mesurent l'incertitude des votes, pas de nouveaux matchs indépendants.
- Le votant local n'évalue pas encore la corrélation réelle entre 20 appels au même modèle ni le ressenti des
  stratégies individuelles.
- Un match finalisé (Switzerland–Colombia) n'exposait pas son score final dans la timeline normalisée ; il a
  été conservé pour ses événements, mais marqué comme anomalie de qualité de données.
- La simplicité perçue doit encore être validée par un petit test utilisateur.

Les règles de production n'ont pas été modifiées par ce playtest. La variante `candidate_cadence` est appliquée
uniquement en mémoire par l'outil de simulation.
