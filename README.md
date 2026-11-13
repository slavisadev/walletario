# LocalWallet

A one-page Chrome extension for tracking the balances of your money accounts in several currencies, with a snapshot history and official NBS exchange rates for a combined total in RSD and EUR.

Everything is stored locally in Chrome (`chrome.storage.local`). If you sign in with Google, the same data is also kept in a hidden, app-only folder of **your own** Google Drive (`appDataFolder`), so it follows your Google account across devices and survives reinstalling the extension. No other server is involved; apart from Drive, the only request the extension makes is for exchange rates.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin **LocalWallet** from the puzzle-piece menu and click its icon to open it in a tab.

After you change the code, click the reload icon on the LocalWallet card in `chrome://extensions`.

The manifest contains a fixed public `key`, so the extension ID is always **`inhfpiahndlpkkjlffimgcdgnknokfeo`** when loaded unpacked. The matching private key (`key.pem`) is kept out of git; back it up, it's only needed to pack a `.crx` yourself.

## Google sign-in setup (one time)

Sign-in uses `chrome.identity`, which works in Google Chrome (not Chromium, Brave and similar browsers).

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and your email, and add the scope `https://www.googleapis.com/auth/drive.appdata`. While the app is in *Testing*, add your Google account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Chrome Extension**, item ID `inhfpiahndlpkkjlffimgcdgnknokfeo`.
5. Copy the client ID into `manifest.json` → `oauth2.client_id`, reload the extension, and click **Sign in with Google**.

When you publish to the Chrome Web Store, the store assigns its own ID: create a second OAuth client for that ID (or upload with this `key` to keep the same one).

### How sync works

- Data is saved as `localwallet.json` in your Drive's app-data folder, which is hidden from the Drive UI and readable only by this extension.
- Every change is saved locally right away and uploaded about 1.5 s later.
- On opening the app, and whenever its tab comes back into view, the Drive copy is downloaded; the newer of the two copies (by `updatedAt`) wins.
- On the first sign-in, if the Google account already has data, you're asked whether to use the Drive copy or upload this device's data.
- Sign out stops syncing on this device; the data stays both locally and in Drive. Edits made on two devices at the same time are not merged: the last one saved wins.

## Features

- **Accounts table:** name, currency, balance and note, edited in place and saved automatically. Balances accept `1'234.50`, `1,234.50` or `1234.5`.
- **Totals per currency.** `DIN`, `dinar`, `€`, `euro` and similar spellings are mapped to ISO codes, so `DIN` and `RSD` count as one currency.
- **NBS conversion:** combined total in RSD and EUR using the NBS official middle rate. Rates refresh automatically once a day, or with the **Get NBS rates** button.
- **History:** **Save to history** records the table with an optional note and that day's rates. Each snapshot shows per-currency changes and the change in the EUR total compared with the previous one. Snapshots can be edited, restored to the table, or deleted. Moving a snapshot to a different day fetches the rates for that date.
- **Export/Import JSON** for backups. Importing replaces all current data.

> Uninstalling the extension deletes its local data. If you're signed in with Google, the Drive copy is kept; otherwise export a backup regularly.

## Exchange rates

NBS publishes its official rates only through a SOAP web service that requires registration, so the extension reads the same NBS middle rates from [kurs.resenje.org](https://kurs.resenje.org), which republishes them as JSON:

- `GET https://kurs.resenje.org/api/v1/rates/today`
- `GET https://kurs.resenje.org/api/v1/rates/YYYY-MM-DD`

The rate per unit is `exchange_middle / parity`, in RSD.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 definition, storage, identity and rate-service/Drive permissions, OAuth client ID |
| `background.js` | Opens or focuses the app tab when the toolbar icon is clicked |
| `app.html` / `app.css` / `app.js` | The single page: table, totals, conversion, history, Google Drive sync |

## Data format

```json
{
  "accounts": [{ "id": "…", "name": "Intesa", "currency": "RSD", "balance": 0, "note": "" }],
  "history": [{ "id": "…", "ts": "ISO date", "note": "", "accounts": [ … ], "rates": { "date": "YYYY-MM-DD", "fetchedAt": "ISO date", "map": { "RSD": 1, "EUR": 117.6 } } }],
  "rates": { "date": "YYYY-MM-DD", "fetchedAt": "ISO date", "map": { … } },
  "updatedAt": "ISO date of the last change, used to pick the newer copy when syncing"
}
```
