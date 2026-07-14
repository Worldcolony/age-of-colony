# Sugar V0 — playtest sur de vrais matchs TXLine

Date : 2026-07-13

Mise en production de la variante retenue : 2026-07-14.

## Résumé

La V0 avant correction n'était pas assez lisible ni équilibrée sur une vraie timeline de football.
Le problème principal n'est pas le plafond de `10 Sugar`, mais le rythme de création des marchés :
le moteur précédent produisait en moyenne **293 marchés candidats par match** lorsqu'aucune colonie ne prend
position, et encore **148 à 205 marchés** dans les rooms mixtes testées.

La règle de production conserve plusieurs marchés ouverts, mais n'en fait arriver qu'un environ toutes
les cinq minutes de match. Elle tourne entre prochain corner, prochain carton, prochain remplacement et
prochain but, avec au maximum trois marchés standards ouverts. Le penalty reste une exception immédiate.

La campagne de validation du 14 juillet produit **174 marchés sur 8 matchs**, soit **21,8 marchés par
match** avant les choix des colonies. Avec des votes neutres, les trois tempéraments terminent toujours près
des `20 Sugar` de départ : `19,96` prudent, `20,12` équilibré et `18,98` agressif.

## Méthode

- 8 matchs finalisés récupérés par TXLine parmi 50 fixtures récentes inspectées ;
- contrôle strict de la présence d'un record `game_finalised` avec `statusId=100` ;
- 994 à 1 355 événements normalisés par match ;
- équipes : Argentina–Switzerland, Norway–England, Spain–Belgium, France–Morocco,
  Switzerland–Colombia, Argentina–Egypt, USA–Belgium et Portugal–Spain ;
- mêmes timelines, mêmes seeds et vrai `GameHarness` de production ;
- seul l'appel LLM payant est remplacé par un votant local déterministe ;
- 20 seeds par match et par politique lors de la validation finale ;
- les décisions restent calculées fourmi par fourmi dans le jeu ; le votant local ne remplace que le fournisseur payant.

Commandes de la campagne historique :

```bash
python3 tools/playtest_real_matches.py \
  --days 30 --matches 8 --scan-limit 50 --runs 20 \
  --policies uniform,accuracy_60,reward_chaser \
  --rule-sets current
```

Le mode `current` désigne la règle réellement intégrée. Les chiffres comparatifs historiques ci-dessous
sont conservés comme référence de décision.

## Validation de la rotation concrète

| Marché | Offres | Résultat connu avant la fin | Répartition des résultats connus |
| --- | ---: | ---: | --- |
| Prochain corner | `43` | `90,7 %` | A `56,4 %` / B `43,6 %` |
| Prochain carton | `38` | `76,3 %` | A `69,0 %` / B `31,0 %` |
| Prochain remplacement | `42` | `88,1 %` | A `54,1 %` / B `45,9 %` |
| Prochain but | `38` | `71,1 %` | A `40,7 %` / B `59,3 %` |

Les corners et remplacements se résolvent le plus souvent. Les cartons et buts sont plus souvent annulés
à la fin, mais restent suffisamment présents pour être compréhensibles et jouables. Une annulation libère
les `2 Sugar` sans gain ni perte.

## 1. Trop de marchés sont créés

Le moteur précédent ouvrait cinq contextes à chaque événement de pression ou de tir. Les cooldowns
étaient comptés en nombre d'événements TXLine, pas en temps de match. Avec environ 1 100 événements par
rencontre, les mêmes propositions reviennent beaucoup trop vite.

| Règles | Marchés candidats sans entrée | Marchés vus dans une room active |
| --- | ---: | ---: |
| Anciennes | `293,2 / match` | `148–205 / match` |
| Binaire seulement | `293,2 / match` | `58–107 / match` |
| Binaire + cadence actuelle | `21,8 / match` | `9,6–19,7 / match` |

La variante seulement binaire semble réduire le volume, mais pour une mauvaise raison : davantage de
colonies entrent, leurs positions restent ouvertes et bloquent la recréation du même contexte. La cadence
devient donc dépendante du comportement des colonies. La troisième variante rend le rythme prévisible avec
des cooldowns basés sur l'horloge du match.

## 2. Les marchés à trois choix punissent les styles actifs

Avec des votes uniformes, donc sans avantage prédictif, l'ancienne V0 faisait perdre fortement les styles qui
entrent le plus souvent :

| Anciennes règles, vote neutre | Entrée | Sugar final moyen | Offres refusées faute de Sugar |
| --- | ---: | ---: | ---: |
| Prudent | `1,2 %` | `20,14` | `0,0 %` |
| Équilibré | `7,5 %` | `14,78` | `1,1 %` |
| Agressif | `13,6 %` | `11,53` | `16,9 %` |

Avec la variante binaire et la cadence réduite :

| Variante finale, vote neutre | Entrée | Sugar final moyen | p05 du pire match | Offres refusées faute de Sugar |
| --- | ---: | ---: | ---: | ---: |
| Prudent | `11,3 %` | `19,96` | `14,00` | `0,0 %` |
| Équilibré | `51,6 %` | `20,12` | `9,70` | `0,0 %` |
| Agressif | `82,8 %` | `18,98` | `1,90` | `0,0 %` |

Les moyennes redeviennent neutres, tandis que le prudent protège mieux son mauvais scénario et que
l'agressif accepte beaucoup plus de variance. C'est une différence de tempérament compréhensible.

## 3. Un bon signal reste récompensé sans faire exploser l'économie

Quand chaque fourmi reçoit individuellement le bon résultat avec une probabilité de `60 %`, l'agrégation
des 20 votes donne un avantage fort. L'ancienne V0 amplifiait cet avantage sur près de 200 marchés et faisait
monter le Sugar moyen jusqu'à `114,55` pour l'agressif.

| Signal 60 % | Prudent | Équilibré | Agressif |
| --- | ---: | ---: | ---: |
| Anciennes règles — Sugar moyen | `52,23` | `95,67` | `114,55` |
| Variante finale — Sugar moyen | `25,54` | `32,10` | `34,31` |
| Variante finale — part de première place | `1,4 %` | `34,2 %` | `64,5 %` |

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

### But dans les dix prochaines minutes — retiré de la rotation

Sur les 345 fenêtres observées :

- but : `25,2 %` ;
- aucun but : `74,8 %`.

Le couple `+5 / +1` était presque neutre sur cet échantillon, mais ce marché impose une fenêtre temporelle
moins immédiate à comprendre. Il reste supporté pour relire d'anciennes parties, mais n'est plus créé par la
rotation de production.

### Penalty

Conserver provisoirement `+1` si marqué et passer à `+4` si raté ou arrêté. Avec un risque fixe de `2`, les
deux probabilités de rentabilité s'additionnent exactement à 100 %.

Les données de ce pilote ne permettent pas de mesurer la fréquence réelle des résultats de penalty, car un
bug de détection avait été découvert : les événements `penalty_outcome` ouvraient eux-mêmes un nouveau marché,
et les séances de tirs au but amplifiaient le problème. La production exclut maintenant les événements de résultat
et déduplique pendant cinq minutes de match la confirmation VAR / l'attribution d'un même penalty.

## Règles intégrées

1. Garder `20` fourmis, `20 Sugar`, un risque fixe de `2`, un plafond réservé de `10` et les seuils
   `14/20`, `12/20`, `11/20`.
2. Faire arriver un seul marché standard environ toutes les cinq minutes de match.
3. Tourner entre prochain corner, prochain carton jaune ou rouge, prochain remplacement et prochain but.
4. Autoriser au maximum trois marchés standards ouverts simultanément ; un événement réel résout tous les
   marchés correspondants encore ouverts.
5. Utiliser A/B `+2 / +2` ; aucun événement avant la fin donne un void.
6. Garder les décisions `per_ant` indépendantes : aucune décision commune par batch dans les parties live.
7. Passer le penalty à `+1 / +4`, ne jamais ouvrir un marché depuis `penalty_outcome`, et appliquer une
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

Ces règles sont maintenant celles de production. L'outil de campagne teste directement le mode `current`, sans
variante temporaire appliquée en mémoire.
