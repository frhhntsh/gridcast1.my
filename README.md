# GridCast.my

AI load forecasting & demand-response decision support for Malaysian commercial buildings.
FYP — Universiti Putra Malaysia. A **static web app** (no server needed) + a Python training pipeline.

```
gridcast/
├─ public/                 ← the website (this folder is what you deploy)
│  ├─ index.html, css/, js/, assets/, vendor/
│  └─ data/gridcast_data.json   ← forecasts + benchmark exported by the pipeline (~420 KB)
├─ pipeline/               ← Python: cleans data, trains XGBoost/CatBoost/LightGBM, exports the JSON
├─ tests/                  ← proves the JS bill/demand-response engine == the Python reference
├─ legacy_streamlit/       ← the earlier Streamlit prototype (kept for reference)
└─ vercel.json
```

## Run it locally
```bash
cd public
python -m http.server 8000      # then open http://localhost:8000
```
(Open it through a server — double-clicking index.html won't work because the app loads a JSON file.)

## Deploy on Vercel (free, no build step)
**Option A – CLI (fastest)**
```bash
npm i -g vercel
cd gridcast
vercel            # first run: answer the prompts (framework: Other). 
vercel --prod     # publishes https://<project>.vercel.app
```
`vercel.json` already tells Vercel to serve the `public` folder.

**Option B – GitHub**: push this folder to a GitHub repo → vercel.com → *Add New Project* → import it →
Framework Preset **Other**, Output Directory **public**, no build command → Deploy.

**Custom domain (gridcast.my)**: Vercel → Project → Settings → Domains → add `gridcast.my`, then add the DNS
records Vercel shows you at the registrar where the .my domain is bought. Netlify, Cloudflare Pages and GitHub
Pages also work — it is just static files.

## Re-train / refresh the data
```bash
cd pipeline
pip install -r requirements.txt
python gridcast_pipeline.py --excel "SEWA Electricity Demand Forecasting (Checked) - 2020&2021.xlsx"
python gridcast_pipeline.py --excel "..." --trials 25     # Bayesian (Optuna) tuning – Stage 6 of the proposal
```
This rewrites `public/data/gridcast_data.json`. Commit it and redeploy.

## Check the maths
```bash
cd tests && node engine_check.mjs && python engine_check.py && node scenario_check.mjs     # expects WORST DIFFERENCE ≈ 1e-9
```

## How the demo works (for the pitch)
* The **demo clock** can be set to *any* date. The research dataset covers one year (2021), so your date is
  matched to the same weekday in 2021 and the page says so. With a real smart meter connected, the clock is just "now".
* **▶ Run the live demo** advances one hour per ~1.5 s and **pauses automatically** when GridCast raises a peak alert.
* **Building settings** (top-right chip) change name, size, tariff, flexible load and model — everything recalculates.
* Settings are stored in the browser (localStorage). Nothing leaves the user's device.

## What-if studio
The **What-if** tab answers "what happens if we turn the aircond down at certain hours?":
pick the hours, how much of the aircond you cut (off, or a % / setpoint rise), how you restart, weekdays or every day.
It shows the change in **bill, peak charge, energy and room temperature**, warns about the **rebound ("snap-back") peak**,
lets you **pin scenarios to compare**, and has a **"Find the best plan"** search that keeps the room under your comfort limit.
Assumptions (editable): aircond = 50% of load, 30% of the saved energy comes back after, one-room warm-up model with a
building time-constant, typical Malaysian outdoor weather (25–33 °C). The dataset has no aircond sub-meter, so treat comfort
numbers as indicative and calibrate with your own chiller data.

## Tariff (TNB RP4, effective 1 Jul 2025)
| | MV General (ex-C1) | MV ToU (ex-C2) |
|---|---|---|
| Energy | 29.83 sen/kWh | peak 31.32 / off-peak 27.23 sen/kWh |
| Capacity + Network | RM 29.43 + 59.84 = **RM 89.27**/kW | RM 30.19 + 66.87 = **RM 97.06**/kW |
| Retail | RM 200/month | RM 200/month |
| Peak window | – | 2 pm–10 pm Mon–Fri (peak-period MD only) |
Plus monthly **AFA** (sen/kWh, editable). Legacy C1/C2 presets are included for comparison. Verify against your own bill.

## Honest limits
* Demo building = SEWA (Sharjah) utility load, rescaled. A real building needs its own meter history and a re-train.
* Hourly data: TNB bills on the highest **half-hour**, so real peaks are slightly higher. Public holidays are not off-peak yet.
* Advice only — GridCast never switches equipment.
