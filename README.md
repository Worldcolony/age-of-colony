# Age of Colony - TXLine Match Monitor

Mini application Python/FastAPI pour lire les fixtures et scores TXLine, avec une interface simple pour suivre les matchs en direct et consulter l'historique des moments forts.

Voir aussi : [données TXLine accessibles](docs/txline-data.md).

## Configuration

Les credentials TXLine doivent rester dans des variables d'environnement :

```bash
export TXLINE_JWT="..."
export TXLINE_API_TOKEN="..."
```

Optionnel :

```bash
export TXLINE_BASE_URL="https://txline.txodds.com"
export TXLINE_COMPETITION_ID="123"
```

## Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Lancement

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Ouvre ensuite http://127.0.0.1:8000.

## Endpoints utiles

- `GET /api/fixtures` : fixtures TXLine, avec filtres `date`, `start_epoch_day`, `competition_id`, `search`
- `GET /api/fixtures/upcoming` : prochains matchs, avec filtres `date`, `days`, `limit`, `competition_id`, `search`
- `GET /api/scores/{fixture_id}/snapshot` : derniers snapshots par action
- `GET /api/scores/{fixture_id}/updates` : updates du bloc courant de 5 minutes
- `GET /api/scores/{fixture_id}/historical` : historique complet du fixture
- `GET /api/scores/{fixture_id}/timeline?source=historical&include_possession=true` : timeline normalisée avec moments forts, dont les changements de possession
- `GET /api/scores/{fixture_id}/details` : infos match, compositions, contexte et stats extraites
- `GET /api/scores/{fixture_id}/full?include_raw=true` : paquet complet avec brut TXLine, timeline, inventaire et dernier état connu
- `GET /api/scores/interval?date=YYYY-MM-DD&hour=12&interval=0` : updates historiques d'un intervalle de 5 minutes
- `GET /api/live/events` : proxy SSE du flux score live TXLine
