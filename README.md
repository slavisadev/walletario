# LocalWallet

A one-page Chrome extension for tracking the balances of your money accounts in several currencies, with a snapshot history and official NBS exchange rates for a combined total in RSD and EUR.

Everything is stored locally in Chrome (`chrome.storage.local`). Nothing is sent anywhere except the request for exchange rates.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin **LocalWallet** from the puzzle-piece menu and click its icon to open it in a tab.

After you change the code, click the reload icon on the LocalWallet card in `chrome://extensions`.

## Features

- **Accounts table:** name, currency, balance and note, edited in place and saved automatically. Balances accept `1'234.50`, `1,234.50` or `1234.5`.
- **Totals per currency.** `DIN`, `dinar`, `€`, `euro` and similar spellings are mapped to ISO codes, so `DIN` and `RSD` count as one currency.
- **NBS conversion:** combined total in RSD and EUR using the NBS official middle rate. Rates refresh automatically once a day, or with the **Get NBS rates** button.
- **History:** **Save to history** records the table with an optional note and that day's rates. Each snapshot shows per-currency changes and the change in the EUR total compared with the previous one. Snapshots can be edited, restored to the table, or deleted. Moving a snapshot to a different day fetches the rates for that date.
- **Export/Import JSON** for backups. Importing replaces all current data.

> Uninstalling the extension deletes its data. Export a backup regularly.

## Exchange rates

NBS publishes its official rates only through a SOAP web service that requires registration, so the extension reads the same NBS middle rates from [kurs.resenje.org](https://kurs.resenje.org), which republishes them as JSON:

- `GET https://kurs.resenje.org/api/v1/rates/today`
- `GET https://kurs.resenje.org/api/v1/rates/YYYY-MM-DD`

The rate per unit is `exchange_middle / parity`, in RSD.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 definition, storage and rate-service permissions |
| `background.js` | Opens or focuses the app tab when the toolbar icon is clicked |
| `app.html` / `app.css` / `app.js` | The single page: table, totals, conversion, history |

## Data format

```json
{
  "accounts": [{ "id": "…", "name": "Intesa", "currency": "RSD", "balance": 0, "note": "" }],
  "history": [{ "id": "…", "ts": "ISO date", "note": "", "accounts": [ … ], "rates": { "date": "YYYY-MM-DD", "fetchedAt": "ISO date", "map": { "RSD": 1, "EUR": 117.6 } } }],
  "rates": { "date": "YYYY-MM-DD", "fetchedAt": "ISO date", "map": { … } }
}
```
