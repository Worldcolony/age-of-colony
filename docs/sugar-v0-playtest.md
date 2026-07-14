# Sugar V0 — first balance playtest

Date: 2026-07-12  
Command: `python3 tools/playtest_sugar.py --runs 300 --policies all --seed 20260712`

> Historical report. Production now opens one binary market roughly every five match minutes, rotating between corner, card, substitution and next goal, with at most three standard markets open. The tables below describe the rules before that integration.

This campaign ran 1,500 replays through the production `GameHarness` with deterministic local voters. The single bundled football timeline stayed fixed; only the voting policy and seed varied. These results validate the economy and expose structural sensitivities, but they are not estimates of real football odds.

## Reward coherence

With a fixed loss of `2 Sugar` and a net reward `R`, an option needs a win probability of `2 / (R + 2)` to break even. For mutually exclusive outcomes, the sum of those probabilities should be close to 100%.

| Market | Rewards | Break-even sum | Reading |
| --- | ---: | ---: | --- |
| Penalty | `+1 / +5` | 95.2% | slightly generous |
| Goal in next 10 minutes | `+4 / +1` | 100.0% | coherent |
| Next goal team / none | `+4 / +4 / +1` | 133.3% | punitive |
| Next corner team / none | `+2 / +2 / +1` | 166.7% | strongly punitive |
| Next free kick team / none | `+2 / +2 / +1` | 166.7% | strongly punitive |
| Next yellow card team / none | `+3 / +3 / +1` | 146.7% | punitive |
| Next foul team | `+2 / +2` | 100.0% | coherent, but not currently opened by the normal event path |

The main issue is the third option, “no event before full time”. Its true probability changes sharply with the minute, while its reward stays fixed.

## Temperament sensitivity

### Uniform ant votes

| Temperament | Entry rate | Mean final Sugar | First-place share | Sugar per entry |
| --- | ---: | ---: | ---: | ---: |
| Cautious | 3.9% | 20.21 | 25.2% | +0.67 |
| Balanced | 21.3% | 20.33 | 26.3% | +0.20 |
| Aggressive | 38.7% | 21.53 | 48.5% | +0.49 |

### Ants individually correct 60% of the time

| Temperament | Entry rate | Mean final Sugar | First-place share | Sugar per entry |
| --- | ---: | ---: | ---: | ---: |
| Cautious | 24.7% | 24.83 | 1.7% | +2.45 |
| Balanced | 62.0% | 31.52 | 36.3% | +2.32 |
| Aggressive | 79.8% | 33.79 | 62.0% | +2.16 |

### Reward-chasing ants

| Temperament | Entry rate | Mean final Sugar | First-place share | Sugar per entry |
| --- | ---: | ---: | ---: | ---: |
| Cautious | 45.3% | 26.53 | 42.3% | +1.80 |
| Balanced | 69.2% | 25.47 | 30.6% | +0.99 |
| Aggressive | 88.0% | 24.74 | 27.1% | +0.67 |

This inversion is healthy in principle: aggressive benefits when the information is good, while cautious protects itself from a poor policy. The current gaps are nevertheless large enough that vote quality may dominate every other decision. The 50/60/70% policies describe each ant's individual signal accuracy; aggregation across 20 ants can make the selected colony position much more accurate than that percentage.

## Exact neutral-vote effect

With 20 independent voters, no abstention, and equally likely choices:

| Market shape | Aggressive 11/20 | Balanced 12/20 | Cautious 14/20 |
| --- | ---: | ---: | ---: |
| Two outcomes | 82.4% entry | 50.3% | 11.5% |
| Three outcomes | 11.3% entry | 3.9% | 0.26% |

Therefore, raising Balanced to 65% would be counterproductive. The number of outcomes already changes participation much more than the one-vote gap between Aggressive and Balanced.

## Recommendation for the next iteration

Keep unchanged:

- 20 fixed ants and 20 starting Sugar;
- fixed risk of 2 Sugar;
- maximum 10 Sugar reserved;
- thresholds 11 / 12 / 14;
- goal-in-next-10 rewards `+4 / +1`.

Simplify the event markets to two choices:

- team A or team B;
- reward `+2 / +2`;
- if the event never happens before full time, void the market and release the 2 Sugar.

For penalties, use `+1` for scored and `+4` for missed/saved. This produces an exact 100% break-even sum and is a little less inflationary than `+1 / +5`.

Implementation status (2026-07-14): completed. Production uses binary team markets at `+2 / +2`, penalty at `+1 / +4`, a five-minute match-clock cadence, and independent per-ant decisions. Goal-in-next-10 remains readable for historical games but is no longer opened by the live rotation.
