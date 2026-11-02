# =============================================================================
# SEWA hourly load forecasting: XGBoost vs CatBoost vs LightGBM
# Improved pipeline: clean data -> features -> baselines -> time-series CV
#                    -> final hold-out test -> diagnostics -> save best model
# =============================================================================
# !pip install catboost lightgbm xgboost scikit-learn pandas openpyxl matplotlib joblib

import warnings
import joblib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import xgboost as xgb
import lightgbm as lgb
import catboost as cb
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

warnings.filterwarnings("ignore")

# ----------------------------- CONFIG ----------------------------------------
EXCEL_PATH = "SEWA Electricity Demand Forecasting (Checked) - 2020&2021.xlsx"
HORIZON = 1          # forecast horizon in hours (1 = next hour, 24 = day-ahead)
TEST_FRACTION = 0.15 # final untouched chronological hold-out
N_SPLITS = 5         # expanding-window CV folds on the development set
SEED = 42
# -----------------------------------------------------------------------------


# ============================ 1. LOAD DATA ===================================
def load_2020_hourly(path):
    """2020 sheet is 'wide': 9 rows per day (A..H = feeders, I = total),
    columns 00:00 ... 24:00. We use row 'I' and the hour-ending columns 01:00-24:00."""
    raw = pd.read_excel(path, sheet_name=" Load 2020 hourly", header=None)
    body = raw.iloc[1:].copy()
    body[0] = body[0].ffill()                       # date only appears on first row of block
    total = body[body[26] == "I"]                   # column 26 holds the row label
    dates = pd.to_datetime(total[0].values)
    vals = total.iloc[:, 2:26].astype(float).values  # 01:00 ... 24:00 (24 columns)
    ts = (dates.values[:, None] + pd.to_timedelta(np.arange(1, 25), unit="h").values[None, :]).ravel()
    return pd.Series(vals.ravel(), index=pd.DatetimeIndex(ts), name="load")


def load_2021_hourly(path):
    """2021 sheet: the 'Time' column is corrupted in ~72 rows (Excel turned labels
    into values like 18:20 or 1900-01-08). Every date has exactly 24 rows in order,
    so we rebuild the hour from row position instead of parsing 'Time'."""
    df = pd.read_excel(path, sheet_name=" Load 2021 hourly", header=1)
    df = df.dropna(subset=["Date", "Total"]).reset_index(drop=True)
    df["Date"] = pd.to_datetime(df["Date"])
    counts = df.groupby("Date").size()
    assert (counts == 24).all(), "Some dates do not have 24 rows - check the sheet"
    hour_ending = df.groupby("Date").cumcount() + 1          # 1..24
    ts = df["Date"] + pd.to_timedelta(hour_ending, unit="h")  # 24 -> next-day 00:00
    return pd.Series(df["Total"].astype(float).values, index=pd.DatetimeIndex(ts), name="load")


def load_weather(path, sheet):
    w = pd.read_excel(path, sheet_name=sheet, header=2).dropna(subset=["Date"])
    w["date"] = pd.to_datetime(w["Date"]).dt.normalize()
    w = w[["date", "Temp", "Hum", "MAX Tem", "Min Tem"]].set_index("date")
    # some cells were stored by Excel as dates/text -> turn anything non-numeric into NaN
    return w.apply(pd.to_numeric, errors="coerce")


load = pd.concat([load_2020_hourly(EXCEL_PATH), load_2021_hourly(EXCEL_PATH)]).sort_index()
load = load[~load.index.duplicated(keep="first")]

weather = pd.concat([
    load_weather(EXCEL_PATH, "2020 Load Distribution"),
    load_weather(EXCEL_PATH, "2021 Load Distribution"),
]).sort_index()
weather = weather[~weather.index.duplicated(keep="first")]


# ============================ 2. CLEAN =======================================
# --- load: enforce a complete hourly grid, flag gaps/outliers, interpolate ----
full_idx = pd.date_range(load.index.min(), load.index.max(), freq="h")
n_missing = len(full_idx) - len(load)
load = load.reindex(full_idx)
load[load <= 0] = np.nan                       # a zero total load is a data error
roll_med = load.rolling(24 * 7, center=True, min_periods=24).median()
roll_mad = (load - roll_med).abs().rolling(24 * 7, center=True, min_periods=24).median()
spike = (load - roll_med).abs() > 8 * 1.4826 * roll_mad.clip(lower=1)
n_spikes = int(spike.sum())
load[spike] = np.nan
load = load.interpolate(limit=6, limit_direction="both")  # only fill short gaps
print(f"Hourly grid: {len(load)} rows | missing hours added: {n_missing} | "
      f"spikes removed: {n_spikes} | still NaN: {int(load.isna().sum())}")

# --- weather: remove physically impossible values, then fill ------------------
weather.loc[weather["Hum"] > 100, "Hum"] = np.nan                     # e.g. 647 %
weather.loc[weather["Hum"] < 0, "Hum"] = np.nan
bad = (weather["MAX Tem"] < weather["Min Tem"])                       # max < min
weather.loc[bad, ["MAX Tem", "Min Tem"]] = np.nan
weather.loc[weather["Min Tem"] > weather["Temp"] + 5, "Min Tem"] = np.nan  # e.g. min 51 C
weather.loc[weather["MAX Tem"] < weather["Temp"] - 5, "MAX Tem"] = np.nan
weather = weather.reindex(pd.date_range(weather.index.min(), weather.index.max(), freq="D"))
weather = weather.interpolate(limit=5, limit_direction="both")

df = load.to_frame("load")
# hour-ending 24:00 already sits on the next day's 00:00, so map on the *interval start*
df["date"] = (df.index - pd.Timedelta(hours=1)).normalize()
df = df.join(weather, on="date").drop(columns="date")


# ============================ 3. FEATURES ====================================
def make_features(d, horizon):
    out = d.copy()
    # lags: only lags >= horizon are available at forecast time (no leakage)
    for lag in [1, 2, 3, 24, 48, 168]:
        if lag >= horizon:
            out[f"lag_{lag}"] = out["load"].shift(lag)
    # rolling stats, shifted by `horizon` so they only use known data
    base = out["load"].shift(horizon)
    out["roll_mean_24"] = base.rolling(24).mean()
    out["roll_std_24"] = base.rolling(24).std()
    out["roll_mean_168"] = base.rolling(168).mean()
    # calendar
    out["hour"] = out.index.hour
    out["dayofweek"] = out.index.dayofweek
    out["month"] = out.index.month
    out["is_weekend"] = out["dayofweek"].isin([4, 5]).astype(int)  # Fri/Sat weekend (UAE, 2020-21)
    out["hour_sin"] = np.sin(2 * np.pi * out["hour"] / 24)
    out["hour_cos"] = np.cos(2 * np.pi * out["hour"] / 24)
    out["doy_sin"] = np.sin(2 * np.pi * out.index.dayofyear / 365.25)
    out["doy_cos"] = np.cos(2 * np.pi * out.index.dayofyear / 365.25)
    # weather interaction
    out["temp_range"] = out["MAX Tem"] - out["Min Tem"]
    out["cooling_deg"] = (out["Temp"] - 24).clip(lower=0)   # cooling-demand proxy
    return out


data = make_features(df, HORIZON).dropna()
target = "load"
features = [c for c in data.columns if c != target]
print(f"Modelling table: {data.shape} | {data.index.min()} -> {data.index.max()}")
print("Features:", features)


# ============================ 4. SPLIT =======================================
n_test = int(len(data) * TEST_FRACTION)
dev, test = data.iloc[:-n_test], data.iloc[-n_test:]
print(f"Development: {len(dev)} h ({dev.index.min().date()} -> {dev.index.max().date()}) | "
      f"Test: {len(test)} h ({test.index.min().date()} -> {test.index.max().date()})")


# ============================ 5. METRICS =====================================
def evaluate(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    return {
        "MAE": mean_absolute_error(y_true, y_pred),
        "RMSE": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "MAPE_%": float(np.mean(np.abs((y_true - y_pred) / y_true)) * 100),
        "R2": r2_score(y_true, y_pred),
    }


# ============================ 6. MODELS ======================================
def get_models():
    return {
        "XGBoost": xgb.XGBRegressor(
            n_estimators=600, learning_rate=0.05, max_depth=6, subsample=0.8,
            colsample_bytree=0.8, reg_lambda=1.0, random_state=SEED, n_jobs=-1),
        "CatBoost": cb.CatBoostRegressor(
            iterations=600, learning_rate=0.05, depth=6, verbose=0,
            random_seed=SEED, thread_count=-1),
        "LightGBM": lgb.LGBMRegressor(
            n_estimators=600, learning_rate=0.05, num_leaves=31, subsample=0.8,
            subsample_freq=1, colsample_bytree=0.8, random_state=SEED,
            verbose=-1, n_jobs=-1),
    }


# ============================ 7. BASELINES ===================================
# A model is only useful if it beats these.
baseline_rows = {}
if HORIZON <= 1:
    baseline_rows["Naive (lag-1)"] = evaluate(test[target], test["lag_1"])
baseline_rows["Seasonal naive (lag-24)"] = evaluate(test[target], test["lag_24"])
baseline_rows["Seasonal naive (lag-168)"] = evaluate(test[target], test["lag_168"])


# ============================ 8. TIME-SERIES CV ==============================
# Expanding window on the development set. Shows how stable each model is
# across different periods/seasons, instead of one lucky/unlucky split.
tscv = TimeSeriesSplit(n_splits=N_SPLITS, test_size=24 * 30, gap=HORIZON)
cv_rows = []
for fold, (tr, va) in enumerate(tscv.split(dev), 1):
    Xtr, ytr = dev.iloc[tr][features], dev.iloc[tr][target]
    Xva, yva = dev.iloc[va][features], dev.iloc[va][target]
    for name, model in get_models().items():
        model.fit(Xtr, ytr)
        m = evaluate(yva, model.predict(Xva))
        cv_rows.append({"fold": fold, "model": name, **m})
cv = pd.DataFrame(cv_rows)
cv_summary = cv.groupby("model")[["MAE", "RMSE", "MAPE_%", "R2"]].agg(["mean", "std"]).round(3)
print("\n=== Time-series CV (mean, std over folds) ===")
print(cv_summary)

best_name = cv.groupby("model")["RMSE"].mean().idxmin()
print(f"\nBest model by CV RMSE: {best_name}")


# ============================ 9. FINAL HOLD-OUT TEST =========================
# Refit each model on ALL development data, evaluate once on the untouched test set.
X_dev, y_dev = dev[features], dev[target]
X_test, y_test = test[features], test[target]

fitted, preds, test_rows = {}, {}, {}
for name, model in get_models().items():
    model.fit(X_dev, y_dev)
    fitted[name] = model
    preds[name] = model.predict(X_test)
    test_rows[name] = evaluate(y_test, preds[name])

results = pd.DataFrame({**baseline_rows, **test_rows}).T.round(3).sort_values("RMSE")
print("\n=== Hold-out test results (baselines + models) ===")
print(results)
results.to_csv("model_comparison_test.csv")
cv.to_csv("cv_fold_results.csv", index=False)


# ============================ 10. DIAGNOSTICS ================================
best_test_name = min(test_rows, key=lambda k: test_rows[k]["RMSE"])
print(f"\nBest model on hold-out test: {best_test_name}")

fig, axes = plt.subplots(2, 2, figsize=(16, 10))

# (a) actual vs predicted, last 2 weeks of test
last = slice(-24 * 14, None)
axes[0, 0].plot(y_test.index[last], y_test.values[last], label="Actual", color="black", lw=1.5)
for name, p in preds.items():
    axes[0, 0].plot(y_test.index[last], p[last], label=name, alpha=0.8)
axes[0, 0].set_title("Actual vs predicted (last 14 days of test)")
axes[0, 0].set_ylabel("Load (MW)"); axes[0, 0].legend()

# (b) error by hour of day
err = pd.DataFrame({n: np.abs(y_test.values - p) for n, p in preds.items()}, index=y_test.index)
err.groupby(err.index.hour).mean().plot(ax=axes[0, 1])
axes[0, 1].set_title("MAE by hour of day"); axes[0, 1].set_xlabel("Hour"); axes[0, 1].set_ylabel("MAE (MW)")

# (c) CV RMSE per fold
cv.pivot(index="fold", columns="model", values="RMSE").plot(marker="o", ax=axes[1, 0])
axes[1, 0].set_title("CV RMSE per fold"); axes[1, 0].set_ylabel("RMSE (MW)")

# (d) feature importance of the best model
m = fitted[best_test_name]
imp = pd.Series(m.feature_importances_, index=features).sort_values().tail(15)
imp.plot.barh(ax=axes[1, 1]); axes[1, 1].set_title(f"Top features - {best_test_name}")

plt.tight_layout()
plt.savefig("model_diagnostics.png", dpi=150)
plt.show()


# ============================ 11. SAVE FOR DASHBOARD =========================
joblib.dump({"model": fitted[best_test_name], "features": features,
             "horizon": HORIZON, "name": best_test_name}, "best_load_model.joblib")
print(f"Saved best_load_model.joblib ({best_test_name}), model_comparison_test.csv, "
      f"cv_fold_results.csv, model_diagnostics.png")
