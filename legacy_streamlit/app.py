"""
Smart Grid Assistant - AI-driven load forecasting & demand-response dashboard
=============================================================================
Decision-support web app for commercial building managers (no device actuation).
Layout is inspired by the myTNB app: one simple home screen, big readable numbers,
usage by day/month, a bill breakdown and plain-language alerts.

Run:   pip install -r requirements.txt
       streamlit run app.py

Pages:  Home | Usage | Bills | Savings | Alerts | AI Model (benchmark, data quality, assumptions)
"""

from __future__ import annotations

import glob
import hashlib
import inspect
import io
import os
import re
import warnings
from dataclasses import dataclass, replace
import datetime as dt

import catboost as cb
import lightgbm as lgb
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
import streamlit as st
import xgboost as xgb
from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_error,
    precision_recall_fscore_support,
    r2_score,
)
from sklearn.model_selection import TimeSeriesSplit

warnings.filterwarnings("ignore")

try:  # Bayesian optimisation is optional
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except Exception:  # pragma: no cover
    HAS_OPTUNA = False

st.set_page_config(
    page_title="AI Smart Grid & Demand Response Dashboard",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# =============================================================================
# CONSTANTS
# =============================================================================
SEED = 42
DEFAULT_EXCEL = "SEWA Electricity Demand Forecasting (Checked) - 2020&2021.xlsx"
LAGS = [1, 2, 3, 24, 48, 168]
MODEL_NAMES = ["XGBoost", "CatBoost", "LightGBM"]
SPLIT_MODES = {
    "Proposal split: train 2020 → test 2021": pd.Timestamp("2021-01-01"),
    "Extended split: train → 13 Sep 2021, test 14 Sep → 31 Dec 2021": pd.Timestamp("2021-09-14"),
}
DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

DEFAULT_PARAMS = {
    "XGBoost": dict(n_estimators=600, learning_rate=0.05, max_depth=6, subsample=0.8,
                    colsample_bytree=0.8, reg_lambda=1.0, min_child_weight=1),
    "LightGBM": dict(n_estimators=600, learning_rate=0.05, num_leaves=31, subsample=0.8,
                     colsample_bytree=0.8, min_child_samples=20, reg_lambda=0.0),
    "CatBoost": dict(iterations=600, learning_rate=0.05, depth=6, l2_leaf_reg=3.0),
}


# =============================================================================
# TARIFF MODEL
# =============================================================================
@dataclass(frozen=True)
class Tariff:
    name: str
    md_rate: float            # RM per kW per month
    peak_rate: float          # RM per kWh
    offpeak_rate: float       # RM per kWh
    md_peak_only: bool        # True: MD measured in peak period only (C2/E2); False: all hours (C1/E1)
    peak_start: int = 8       # inclusive, hour of day
    peak_end: int = 22        # exclusive
    offpeak_days: tuple = (5, 6)   # Mon=0 ... Sun=6 -> Sat & Sun are off-peak all day
    other_pct: float = 0.0    # extra % charges (e.g. KWTBB, service tax) - optional


PRESETS = {
    "C2 – MV Peak/Off-Peak Commercial": Tariff(
        "C2 – MV Peak/Off-Peak Commercial", md_rate=45.10, peak_rate=0.365,
        offpeak_rate=0.224, md_peak_only=True),
    "C1 – MV General Commercial": Tariff(
        "C1 – MV General Commercial", md_rate=30.30, peak_rate=0.365,
        offpeak_rate=0.365, md_peak_only=False),
    "Custom (type your own rates)": Tariff(
        "Custom", md_rate=45.10, peak_rate=0.365, offpeak_rate=0.224, md_peak_only=True),
}


def peak_mask(t0: pd.DatetimeIndex, tariff: Tariff) -> np.ndarray:
    """True for every interval that falls in the tariff's peak period."""
    in_hours = (t0.hour >= tariff.peak_start) & (t0.hour < tariff.peak_end)
    on_day = ~np.isin(t0.dayofweek, list(tariff.offpeak_days))
    return np.asarray(in_hours & on_day)


def _month_label(m: int) -> str:
    return f"{(m - 1) // 12}-{(m - 1) % 12 + 1:02d}"


def month_short(m: int) -> str:
    return pd.Timestamp(year=(m - 1) // 12, month=(m - 1) % 12 + 1, day=1).strftime("%b %y")


def month_name(m: int) -> str:
    """Friendly label, e.g. 'May 2021'."""
    return pd.Timestamp(year=(m - 1) // 12, month=(m - 1) % 12 + 1, day=1).strftime("%B %Y")


def monthly_bill(load_kw, month_ord, pmask, md_mask, tariff: Tariff) -> pd.DataFrame:
    """Energy + Maximum-Demand charges per calendar month (hourly kW == kWh per hour)."""
    d = pd.DataFrame({"m": month_ord, "kw": load_kw, "p": pmask, "md": md_mask})
    rows = []
    for m, g in d.groupby("m"):
        peak_kwh = g.loc[g.p, "kw"].sum()
        off_kwh = g.loc[~g.p, "kw"].sum()
        md_kw = g.loc[g.md, "kw"].max() if g.md.any() else 0.0
        energy = peak_kwh * tariff.peak_rate + off_kwh * tariff.offpeak_rate
        md_cost = md_kw * tariff.md_rate
        total = (energy + md_cost) * (1 + tariff.other_pct / 100)
        rows.append({"month": _month_label(int(m)), "m": int(m), "peak_kWh": peak_kwh,
                     "offpeak_kWh": off_kwh, "MD_kW": md_kw, "energy_RM": energy,
                     "MD_RM": md_cost, "total_RM": total})
    return pd.DataFrame(rows).set_index("m")


# =============================================================================
# DEMAND-RESPONSE ENGINE (energy-conserving load shifting)
# =============================================================================
def _shave(day, mask, max_kw, target_kwh=None, cap_kw=None):
    """Reduction (kW) per hour inside `mask`. Either flatten the highest hours until
    `target_kwh` is removed, or clip everything above `cap_kw`. Each hour is limited to `max_kw`."""
    red = np.zeros_like(day)
    idx = np.flatnonzero(mask)
    if len(idx) == 0 or max_kw <= 0:
        return red
    x = day[idx]
    if cap_kw is not None:
        r = np.minimum(max_kw, np.maximum(0.0, x - cap_kw))
    else:
        def removed(level):
            return np.minimum(max_kw, np.maximum(0.0, x - level)).sum()
        lo, hi = x.min() - max_kw - 1.0, x.max()
        if removed(lo) <= target_kwh:       # cannot reach the target -> shave as much as possible
            level = lo
        else:
            for _ in range(60):
                mid = (lo + hi) / 2
                if removed(mid) > target_kwh:
                    lo = mid
                else:
                    hi = mid
            level = hi
        r = np.minimum(max_kw, np.maximum(0.0, x - level))
    red[idx] = r
    return red


def _fill(day, mask, energy_kwh, max_kw, ceiling):
    """Add `energy_kwh` into the lowest hours of `mask` (valley filling), never above `ceiling`."""
    add = np.zeros_like(day)
    idx = np.flatnonzero(mask)
    if len(idx) == 0 or energy_kwh <= 0 or max_kw <= 0:
        return add
    x = day[idx]

    def added(level):
        return np.minimum(max_kw, np.maximum(0.0, np.minimum(level, ceiling) - x)).sum()

    if added(ceiling) <= energy_kwh:
        level = ceiling
    else:
        lo, hi = x.min(), ceiling
        for _ in range(60):
            mid = (lo + hi) / 2
            if added(mid) < energy_kwh:
                lo = mid
            else:
                hi = mid
        level = hi
    add[idx] = np.minimum(max_kw, np.maximum(0.0, np.minimum(level, ceiling) - x))
    return add


STRATEGIES = {
    "Load shifting": "Move flexible load out of the peak period and recover it off-peak (energy kept, +rebound overhead).",
    "Peak curtailment": "Switch off / throttle flexible load during the highest peak hours (energy is saved, comfort impact).",
    "MD capping": "Hold demand under a target ceiling (% below the month's MD) and recover the energy off-peak.",
}


def apply_dr(load_kw, sdate, month_ord, pmask, md_mask, strategy, shift_kw,
             duration_h, rebound_pct, cap_pct):
    """Apply one strategy on every day. Returns (optimised load, stats)."""
    out = load_kw.copy()
    stats = {"shaved_kWh": 0.0, "recovered_kWh": 0.0, "unrecovered_kWh": 0.0}
    # Tariffs whose MD counts every hour (C1/E1): shave the day's highest hours and refill its valleys.
    # Peak/off-peak tariffs (C2/E2): shave inside the peak period, recover in the off-peak period.
    flat = bool(md_mask.all())
    md_ref = {m: load_kw[(month_ord == m) & md_mask].max() for m in np.unique(month_ord)
              if ((month_ord == m) & md_mask).any()}
    for d in np.unique(sdate):
        idx = np.flatnonzero(sdate == d)
        shave_ok = np.ones(len(idx), dtype=bool) if flat else pmask[idx]
        if not shave_ok.any():
            continue
        day = load_kw[idx]
        if strategy == "MD capping":
            cap = md_ref.get(month_ord[idx][0], day.max()) * (1 - cap_pct / 100.0)
            red = _shave(day, shave_ok, shift_kw, cap_kw=cap)
        else:
            red = _shave(day, shave_ok, shift_kw, target_kwh=shift_kw * duration_h)
        shaved = red.sum()
        add = np.zeros_like(day)
        if strategy != "Peak curtailment" and shaved > 0:
            need = shaved * (1 + rebound_pct / 100.0)
            fill_ok = (red == 0) if flat else ~pmask[idx]
            ceiling = (day - red).max() if flat else day.max()
            add = _fill(day - red, fill_ok, need, shift_kw, ceiling=ceiling)
            stats["recovered_kWh"] += add.sum()
            stats["unrecovered_kWh"] += max(0.0, need - add.sum())
        out[idx] = day - red + add
        stats["shaved_kWh"] += shaved
    return out, stats


# =============================================================================
# DATA LOADING & CLEANING
# =============================================================================
def _clean_time_label(v) -> bool:
    if isinstance(v, dt.time):
        return v.minute == 0 and v.second == 0
    return bool(re.fullmatch(r"\d{1,2}[: ]00(:00)?", str(v).strip()))


def get_excel_bytes(uploaded):
    if uploaded is not None:
        return uploaded.getvalue(), uploaded.name
    candidates = [DEFAULT_EXCEL] + sorted(glob.glob("*SEWA*.xlsx")) + sorted(glob.glob("*.xlsx"))
    for c in candidates:
        if os.path.exists(c):
            with open(c, "rb") as fh:
                return fh.read(), c
    return None, None


@st.cache_data(show_spinner="Loading and cleaning the SEWA workbook …")
def load_dataset(file_bytes: bytes):
    xls = pd.ExcelFile(io.BytesIO(file_bytes))
    report: dict = {}

    # ---- 2020: wide layout, 9 rows/day (A..H feeders, I = total) -------------
    raw = pd.read_excel(xls, sheet_name=" Load 2020 hourly", header=None)
    body = raw.iloc[1:].copy()
    body[0] = body[0].ffill()
    total = body[body[26] == "I"]
    dates = pd.to_datetime(total[0].values)
    vals = total.iloc[:, 2:26].astype(float).values            # hour-ending 01:00 … 24:00
    ts = (dates.values[:, None] + pd.to_timedelta(np.arange(1, 25), unit="h").values[None, :]).ravel()
    s2020 = pd.Series(vals.ravel(), index=pd.DatetimeIndex(ts), name="load")

    # ---- 2021: long layout; Time column is corrupted -> rebuild from row order -
    d21 = pd.read_excel(xls, sheet_name=" Load 2021 hourly", header=1)
    d21 = d21.dropna(subset=["Date", "Total"]).reset_index(drop=True)
    d21["Date"] = pd.to_datetime(d21["Date"])
    report["2021 corrupted time labels (rebuilt from row order)"] = int((~d21["Time"].map(_clean_time_label)).sum())
    he = d21.groupby("Date").cumcount() + 1
    s2021 = pd.Series(d21["Total"].astype(float).values,
                      index=pd.DatetimeIndex(d21["Date"] + pd.to_timedelta(he, unit="h")), name="load")

    load = pd.concat([s2020, s2021]).sort_index()
    load = load[~load.index.duplicated(keep="first")]
    grid = pd.date_range(load.index.min(), load.index.max(), freq="h")
    report["Hours missing from the hourly grid"] = int(len(grid) - len(load))
    load = load.reindex(grid)
    report["Zero / negative load readings"] = int((load <= 0).sum())
    load[load <= 0] = np.nan
    med = load.rolling(168, center=True, min_periods=24).median()
    mad = (load - med).abs().rolling(168, center=True, min_periods=24).median()
    spike = (load - med).abs() > 8 * 1.4826 * mad.clip(lower=1)
    report["Load spikes removed (robust MAD rule)"] = int(spike.sum())
    load[spike] = np.nan
    report["Load hours interpolated"] = int(load.isna().sum())
    load = load.interpolate(limit=6, limit_direction="both")

    # ---- weather (daily) ------------------------------------------------------
    ws = []
    for sheet in ("2020 Load Distribution", "2021 Load Distribution"):
        w = pd.read_excel(xls, sheet_name=sheet, header=2).dropna(subset=["Date"])
        w["date"] = pd.to_datetime(w["Date"]).dt.normalize()
        ws.append(w[["date", "Temp", "Hum", "MAX Tem", "Min Tem"]].set_index("date")
                  .apply(pd.to_numeric, errors="coerce"))
    weather = pd.concat(ws).sort_index()
    weather = weather[~weather.index.duplicated(keep="first")]

    bad_hum = (weather["Hum"] > 100) | (weather["Hum"] < 0)
    weather.loc[bad_hum, "Hum"] = np.nan
    bad_range = weather["MAX Tem"] < weather["Min Tem"]
    weather.loc[bad_range, ["MAX Tem", "Min Tem"]] = np.nan
    bad_min = weather["Min Tem"] > weather["Temp"] + 5
    weather.loc[bad_min, "Min Tem"] = np.nan
    bad_max = weather["MAX Tem"] < weather["Temp"] - 5
    weather.loc[bad_max, "MAX Tem"] = np.nan
    report["Impossible humidity values (>100 %) removed"] = int(bad_hum.sum())
    report["Max-temp < min-temp days removed"] = int(bad_range.sum())
    report["Other inconsistent min/max temperatures removed"] = int(bad_min.sum() + bad_max.sum())
    weather = weather.reindex(pd.date_range(weather.index.min(), weather.index.max(), freq="D"))
    report["Weather values interpolated (days × variables)"] = int(weather.isna().sum().sum())
    weather = weather.interpolate(limit=5, limit_direction="both")

    df = load.to_frame("load")
    df["date"] = (df.index - pd.Timedelta(hours=1)).normalize()   # hour-ending -> service date
    df = df.join(weather, on="date").drop(columns="date")
    report["Rows in final hourly table"] = len(df)
    return df, report


def make_features(d: pd.DataFrame) -> pd.DataFrame:
    out = d.copy()
    t0 = out.index - pd.Timedelta(hours=1)           # start of the interval being forecast
    for lag in LAGS:
        out[f"lag_{lag}"] = out["load"].shift(lag)
    base = out["load"].shift(1)                      # only information known one hour ahead
    out["roll_mean_24"] = base.rolling(24).mean()
    out["roll_std_24"] = base.rolling(24).std()
    out["roll_mean_168"] = base.rolling(168).mean()
    out["hour"] = t0.hour
    out["dayofweek"] = t0.dayofweek
    out["month"] = t0.month
    out["is_friday"] = (pd.Series(t0.dayofweek, index=out.index) == 4).astype(int)  # the SEWA data dips on Fridays only
    out["hour_sin"] = np.sin(2 * np.pi * out["hour"] / 24)
    out["hour_cos"] = np.cos(2 * np.pi * out["hour"] / 24)
    out["doy_sin"] = np.sin(2 * np.pi * t0.dayofyear / 365.25)
    out["doy_cos"] = np.cos(2 * np.pi * t0.dayofyear / 365.25)
    out["temp_range"] = out["MAX Tem"] - out["Min Tem"]
    out["cooling_deg"] = (out["Temp"] - 24).clip(lower=0)
    out["service_date"] = t0.normalize()
    return out


# =============================================================================
# MODELLING
# =============================================================================
def build_model(name: str, p: dict):
    if name == "XGBoost":
        return xgb.XGBRegressor(**p, random_state=SEED, n_jobs=-1)
    if name == "LightGBM":
        return lgb.LGBMRegressor(**p, subsample_freq=1, random_state=SEED, n_jobs=-1, verbose=-1)
    return cb.CatBoostRegressor(**p, random_seed=SEED, verbose=0, thread_count=-1)


def rmse(y, p) -> float:
    return float(np.sqrt(mean_squared_error(y, p)))


def evaluate(y, p) -> dict:
    y, p = np.asarray(y), np.asarray(p)
    return {"MAE": mean_absolute_error(y, p), "RMSE": rmse(y, p),
            "MAPE_%": float(np.mean(np.abs((y - p) / y)) * 100), "R2": r2_score(y, p)}


def suggest_params(trial, name: str) -> dict:
    if name == "XGBoost":
        return dict(n_estimators=trial.suggest_int("n_estimators", 200, 800, step=100),
                    learning_rate=trial.suggest_float("learning_rate", 0.02, 0.2, log=True),
                    max_depth=trial.suggest_int("max_depth", 3, 9),
                    subsample=trial.suggest_float("subsample", 0.6, 1.0),
                    colsample_bytree=trial.suggest_float("colsample_bytree", 0.6, 1.0),
                    min_child_weight=trial.suggest_int("min_child_weight", 1, 10),
                    reg_lambda=trial.suggest_float("reg_lambda", 1e-2, 10.0, log=True))
    if name == "LightGBM":
        return dict(n_estimators=trial.suggest_int("n_estimators", 200, 800, step=100),
                    learning_rate=trial.suggest_float("learning_rate", 0.02, 0.2, log=True),
                    num_leaves=trial.suggest_int("num_leaves", 15, 127),
                    subsample=trial.suggest_float("subsample", 0.6, 1.0),
                    colsample_bytree=trial.suggest_float("colsample_bytree", 0.6, 1.0),
                    min_child_samples=trial.suggest_int("min_child_samples", 10, 60),
                    reg_lambda=trial.suggest_float("reg_lambda", 1e-2, 10.0, log=True))
    return dict(iterations=trial.suggest_int("iterations", 200, 800, step=100),
                learning_rate=trial.suggest_float("learning_rate", 0.02, 0.2, log=True),
                depth=trial.suggest_int("depth", 4, 8),
                l2_leaf_reg=trial.suggest_float("l2_leaf_reg", 1.0, 10.0, log=True))


def late_folds(n_rows: int, n_splits: int = 5, use_last: int = 2):
    """Expanding-window folds, keeping only the last ones. The first folds train on just a few months
    and cannot extrapolate to other seasons, so they say little about real performance."""
    folds = list(TimeSeriesSplit(n_splits=n_splits).split(np.arange(n_rows)))
    return folds[-use_last:]


def cv_scores(name, params, X, y):
    rows = []
    for tr, va in late_folds(len(X)):
        m = build_model(name, params)
        m.fit(X.iloc[tr], y.iloc[tr])
        rows.append(evaluate(y.iloc[va], m.predict(X.iloc[va])))
    return pd.DataFrame(rows).mean().to_dict()


def tune_bayesian(name, X, y, n_trials):
    def objective(trial):
        p = suggest_params(trial, name)
        return cv_scores(name, p, X, y)["RMSE"]
    study = optuna.create_study(direction="minimize", sampler=optuna.samplers.TPESampler(seed=SEED))
    study.optimize(objective, n_trials=n_trials)
    return study.best_params, study.best_value


def peak_detection(y, p, t0, thr):
    """How well does a model spot peak hours and the daily peak?"""
    yt, pt = np.asarray(y) >= thr, np.asarray(p) >= thr
    prec, rec, f1, _ = precision_recall_fscore_support(yt, pt, average="binary", zero_division=0)
    d = pd.DataFrame({"y": np.asarray(y), "p": np.asarray(p), "day": t0.normalize()})
    g = d.groupby("day")
    a_pos = g["y"].apply(lambda s: int(np.argmax(s.values)))
    p_pos = g["p"].apply(lambda s: int(np.argmax(s.values)))
    mag = (g["p"].max() - g["y"].max()).abs() / g["y"].max() * 100
    return {"Peak-hour precision": prec, "Peak-hour recall": rec, "Peak-hour F1": f1,
            "Daily peak hour exact %": float((a_pos == p_pos).mean() * 100),
            "Daily peak hour ±1 h %": float(((a_pos - p_pos).abs() <= 1).mean() * 100),
            "Daily peak size error %": float(mag.mean())}


@st.cache_resource(show_spinner="Training & benchmarking XGBoost / CatBoost / LightGBM "
                                "(Bayesian tuning can take several minutes) …")
def train_and_benchmark(_data: pd.DataFrame, data_key: str, split_mode: str, n_trials: int):
    data = make_features(_data).dropna()
    features = [c for c in data.columns if c not in ("load", "service_date")]
    split_date = SPLIT_MODES[split_mode]
    train = data[data["service_date"] < split_date]
    test = data[data["service_date"] >= split_date]
    Xtr, ytr, Xte, yte = train[features], train["load"], test[features], test["load"]

    params, tuning = {}, {}
    for name in MODEL_NAMES:
        if n_trials > 0 and HAS_OPTUNA:
            params[name], best = tune_bayesian(name, Xtr, ytr, n_trials)
            tuning[name] = best
        else:
            params[name] = dict(DEFAULT_PARAMS[name])

    models, preds, test_rows, cv_rows = {}, {}, {}, {}
    for name in MODEL_NAMES:
        cv_rows[name] = cv_scores(name, params[name], Xtr, ytr)        # validation inside the training period
        m = build_model(name, params[name]).fit(Xtr, ytr)
        models[name] = m
        preds[name] = m.predict(Xte)
        test_rows[name] = evaluate(yte, preds[name])
    pred_df = pd.DataFrame(preds, index=test.index)

    baselines = {"Naive (lag-1)": test["lag_1"], "Seasonal naive (lag-24)": test["lag_24"],
                 "Seasonal naive (lag-168)": test["lag_168"]}
    base_rows = {k: evaluate(yte, v) for k, v in baselines.items()}

    cv_df = pd.DataFrame(cv_rows).T
    best_cv = cv_df["RMSE"].idxmin()                      # selection uses validation folds, not the test set
    best_test = min(test_rows, key=lambda k: test_rows[k]["RMSE"])

    # out-of-fold relative residuals of the selected model -> prediction intervals / risk
    rel = []
    for tr, va in late_folds(len(Xtr)):
        m = build_model(best_cv, params[best_cv]).fit(Xtr.iloc[tr], ytr.iloc[tr])
        p = m.predict(Xtr.iloc[va])
        rel.append(ytr.iloc[va].values / p - 1.0)
    rel = np.concatenate(rel)

    thr = float(np.quantile(ytr, 0.90))
    t0_test = test.index - pd.Timedelta(hours=1)
    peak_rows = {n: peak_detection(yte, preds[n], t0_test, thr) for n in MODEL_NAMES}
    for k, v in baselines.items():
        peak_rows[k] = peak_detection(yte, v, t0_test, thr)

    imp = pd.DataFrame({n: models[n].feature_importances_ / models[n].feature_importances_.sum()
                        for n in MODEL_NAMES}, index=features)

    return dict(features=features, train=train, test=test, params=params, tuning=tuning, models=models,
                pred=pred_df, test_metrics=pd.DataFrame({**test_rows, **base_rows}).T,
                cv_metrics=cv_df, best_cv=best_cv, best_test=best_test, rel_resid=rel,
                peak=pd.DataFrame(peak_rows).T, importance=imp, peak_threshold_MW=thr)


# =============================================================================
# THEME  (change colours here – everything else follows)
# =============================================================================
THEME = dict(primary="#F36F21", primary_dark="#D95A0B", navy="#1B2A41", bg="#F4F6FA", card="#FFFFFF",
             muted="#6B7A90", ok="#2E9E5B", watch="#F5A524", alert="#E5484D", info="#4C8DF6", soft="#9DB4D3")
TONE = {"ok": THEME["ok"], "watch": THEME["watch"], "alert": THEME["alert"], "info": THEME["info"]}

CSS = """
<style>
html, body, [class*="css"] { font-family: 'Inter','Segoe UI',system-ui,-apple-system,sans-serif; }
.stApp { background: %bg%; }
.block-container { max-width: 1180px; padding-top: 4.2rem; padding-bottom: 3rem; }
header[data-testid="stHeader"] { background: transparent; }
#MainMenu, footer, [data-testid="stToolbar"], [data-testid="stDecoration"] { display: none !important; }
h1, h2, h3, h4, h5 { color: %navy%; }
.topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;
  background:%card%; border-radius:18px; padding:14px 20px; margin-bottom:14px;
  box-shadow:0 2px 12px rgba(27,42,65,.06); }
.brand { display:flex; align-items:center; gap:12px; }
.brand-badge { width:42px; height:42px; border-radius:12px; display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,%primary%,%primary_dark%); color:#fff; font-size:22px; }
.brand-name { font-weight:800; color:%navy%; font-size:18px; line-height:1.15; }
.brand-sub { color:%muted%; font-size:12.5px; }
.chips { display:flex; gap:8px; flex-wrap:wrap; }
.chip { background:#EEF1F6; color:%navy%; border-radius:999px; padding:6px 12px; font-size:12.5px; font-weight:600; }
.hero { border-radius:22px; padding:26px 30px; color:#fff; height:100%;
  background:linear-gradient(135deg,%primary% 0%,%primary_dark% 100%); box-shadow:0 10px 26px rgba(243,111,33,.28); }
.hero-label { font-size:12px; letter-spacing:.09em; font-weight:700; opacity:.92; text-transform:uppercase; }
.hero-value { font-size:58px; font-weight:800; line-height:1.05; margin:6px 0 10px; }
.hero-value span { font-size:21px; font-weight:600; opacity:.92; margin-left:4px; }
.pill { display:inline-flex; align-items:center; gap:8px; border-radius:999px; padding:6px 14px;
  font-weight:700; font-size:13px; background:#fff; color:%navy%; }
.dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
.hero-msg { margin-top:14px; font-size:15px; line-height:1.5; opacity:.98; }
.kpi { background:%card%; border-radius:18px; padding:18px 20px; box-shadow:0 2px 12px rgba(27,42,65,.06); height:100%; }
.kpi-label { color:%muted%; font-size:13px; font-weight:600; }
.kpi-value { color:%navy%; font-size:30px; font-weight:800; margin:4px 0 2px; line-height:1.15; }
.kpi-sub { color:%muted%; font-size:12.5px; line-height:1.4; }
.kpi-sub.good { color:%ok%; font-weight:700; }
.kpi-sub.bad { color:%alert%; font-weight:700; }
.sec-title { font-size:20px; font-weight:800; color:%navy%; margin:26px 0 2px; }
.sec-sub { color:%muted%; font-size:13.5px; margin-bottom:10px; }
.card { background:%card%; border-radius:18px; padding:18px 22px; box-shadow:0 2px 12px rgba(27,42,65,.06); }
.card p { margin:0; color:%navy%; line-height:1.55; font-size:14.5px; }
.save-card { background:linear-gradient(135deg,#E9F7EF,#F6FCF8); border:1px solid #CDEBD9; border-radius:20px; padding:22px 26px; }
.save-big { font-size:40px; font-weight:800; color:%ok%; line-height:1.1; }
.row { display:flex; align-items:center; justify-content:space-between; gap:14px; background:%card%;
  border-radius:14px; padding:12px 16px; margin-bottom:8px; box-shadow:0 1px 6px rgba(27,42,65,.05); }
.row-main { font-weight:700; color:%navy%; font-size:14.5px; }
.row-sub { color:%muted%; font-size:12.5px; }
.tag { border-radius:999px; padding:4px 11px; font-size:12px; font-weight:700; color:#fff; white-space:nowrap; }
.line { display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid #EDF0F5; font-size:14.5px; color:%navy%; }
.line:last-child { border-bottom:none; font-weight:800; font-size:16px; }
.line small { color:%muted%; display:block; font-size:12px; }
div[data-testid="stVerticalBlockBorderWrapper"] { background:%card%; border-radius:18px; }
.stButton > button, .stDownloadButton > button { border-radius:12px; font-weight:700; padding:.55rem 1rem; }
[data-testid="stSidebar"] { background:#FFFFFF; }
</style>
"""
for _k, _v in THEME.items():
    CSS = CSS.replace(f"%{_k}%", _v)
st.markdown(CSS, unsafe_allow_html=True)


# =============================================================================
# SMALL UI HELPERS
# =============================================================================
_PLOTLY_WIDTH = "width" in inspect.signature(st.plotly_chart).parameters


def show_fig(fig, height=340):
    has_title = bool(fig.layout.title.text)
    kw = dict(
        height=height + (50 if has_title else 0),
        margin=dict(l=8, r=8, t=(95 if has_title else 34), b=8),
        legend=dict(orientation="h", x=0.0, xanchor="left", y=1.02, yanchor="bottom", font=dict(size=12)),
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, Segoe UI, sans-serif", color=THEME["navy"]),
        colorway=[THEME["primary"], THEME["navy"], THEME["info"], THEME["ok"], "#9AA7BA"],
    )
    if has_title:
        kw["title"] = dict(x=0.0, xanchor="left", y=0.97, yanchor="top")
    fig.update_layout(**kw)
    fig.update_xaxes(showgrid=False, linecolor="#D9DFE8")
    fig.update_yaxes(gridcolor="#E8ECF2", zeroline=False)
    if _PLOTLY_WIDTH:
        st.plotly_chart(fig, width="stretch")
    else:  # older Streamlit
        st.plotly_chart(fig, use_container_width=True)


def rm(x: float) -> str:
    return f"RM {x:,.0f}"


def section(title: str, sub: str = ""):
    st.markdown(f'<div class="sec-title">{title}</div>' + (f'<div class="sec-sub">{sub}</div>' if sub else ""),
                unsafe_allow_html=True)


def kpi(label: str, value: str, sub: str = "", tone: str = ""):
    st.markdown(f'<div class="kpi"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div>'
                f'<div class="kpi-sub {tone}">{sub}</div></div>', unsafe_allow_html=True)


def note(text: str):
    st.markdown(f'<div class="card"><p>{text}</p></div>', unsafe_allow_html=True)


def pill(text: str, tone: str) -> str:
    return f'<span class="pill"><span class="dot" style="background:{TONE[tone]}"></span>{text}</span>'


def shade_peaks(fig, times, mask):
    """Light-orange band behind every contiguous peak-rate stretch."""
    start = None
    n = len(mask)
    for k, flag in enumerate(mask):
        if flag and start is None:
            start = k
        if start is not None and (not flag or k == n - 1):
            end = k if flag else k - 1
            fig.add_vrect(x0=times[start], x1=times[end] + pd.Timedelta(hours=1),
                          fillcolor="rgba(245,165,36,0.14)", line_width=0, layer="below")
            start = None


def persisted(widget, label, key, default, options=None, lo=None, hi=None, **kw):
    """A widget whose value survives page switches (Streamlit drops state of widgets that are not drawn)."""
    wkey, skey = "w_" + key, "s_" + key
    saved = st.session_state.get(skey, default)
    if options is not None:
        options = list(options)
        if saved not in options:
            saved = default if default in options else options[0]
        if wkey in st.session_state and st.session_state[wkey] not in options:
            del st.session_state[wkey]
    if lo is not None:
        saved = min(max(saved, lo), hi)
        if wkey in st.session_state:
            st.session_state[wkey] = min(max(st.session_state[wkey], lo), hi)
    if wkey not in st.session_state:
        st.session_state[wkey] = saved
    args = {}
    if options is not None:
        args["options"] = options
    if lo is not None:
        args.update(min_value=lo, max_value=hi)
    val = widget(label, key=wkey, **args, **kw)
    st.session_state[skey] = val
    return val


# =============================================================================
# SIDEBAR  (advanced settings live here so the main screens stay simple)
# =============================================================================
st.sidebar.title("⚙️ Settings")
st.sidebar.caption("You can leave these as they are. They are for setting up your building, tariff and AI model.")

with st.sidebar.expander("📁 Data source", expanded=False):
    uploaded = st.file_uploader("SEWA workbook (.xlsx)", type=["xlsx"],
                                help="Leave empty to use the workbook stored next to app.py")

file_bytes, source_name = get_excel_bytes(uploaded)
if file_bytes is None:
    st.error(f"Dataset not found. Put **{DEFAULT_EXCEL}** next to app.py or upload it in the sidebar.")
    st.stop()
try:
    raw_df, cleaning_report = load_dataset(file_bytes)
except Exception as exc:  # noqa: BLE001
    st.error(f"Could not read the workbook ({exc}). Sheets expected: ' Load 2020 hourly', "
             "' Load 2021 hourly', '2020 Load Distribution', '2021 Load Distribution'.")
    st.stop()
data_key = hashlib.md5(file_bytes).hexdigest()

with st.sidebar.form("model_form"):
    st.subheader("🤖 AI model")
    split_mode = st.selectbox("Train / test split", list(SPLIT_MODES), index=0,
                              help="The proposal specifies 2020 for training and 2021 for testing.")
    n_trials = st.slider("Bayesian tuning trials per model (0 = off)", 0, 60, 0, step=5,
                         disabled=not HAS_OPTUNA,
                         help="Optuna TPE search with time-series CV. 20+ trials takes minutes.")
    model_choice = st.selectbox("Forecast model", ["Auto (best validation RMSE)"] + MODEL_NAMES)
    st.form_submit_button("Apply")

st.sidebar.subheader("🏢 Your building & tariff")
building_peak_kw = st.sidebar.number_input(
    "Building annual peak demand (kW)", min_value=100, max_value=50000, value=2000, step=100,
    help="The SEWA data is utility-scale (hundreds of MW). Its shape is rescaled so the dataset's "
         "highest hour equals this building peak.")
preset = st.sidebar.selectbox("TNB tariff", list(PRESETS))
base_t = PRESETS[preset]
with st.sidebar.expander("Edit tariff rates & periods"):
    md_rate = st.number_input("MD charge (RM/kW/month)", value=float(base_t.md_rate), step=0.1, key=f"md_{preset}")
    peak_rate = st.number_input("Peak energy rate (RM/kWh)", value=float(base_t.peak_rate), step=0.005,
                                format="%.3f", key=f"pk_{preset}")
    off_rate = st.number_input("Off-peak energy rate (RM/kWh)", value=float(base_t.offpeak_rate), step=0.005,
                               format="%.3f", key=f"op_{preset}")
    md_peak_only = st.checkbox("MD measured in peak period only", value=base_t.md_peak_only, key=f"mp_{preset}")
    pk_start, pk_end = st.slider("Peak period (hour of day)", 0, 24, (base_t.peak_start, base_t.peak_end),
                                 key=f"ph_{preset}")
    off_days = st.multiselect("Off-peak days", DAY_LABELS, default=[DAY_LABELS[i] for i in base_t.offpeak_days],
                              key=f"od_{preset}")
    other_pct = st.number_input("Other % charges (e.g. KWTBB, service tax)", value=0.0, step=0.5, key=f"ot_{preset}")
tariff = Tariff(preset, md_rate, peak_rate, off_rate, md_peak_only, pk_start, pk_end,
                tuple(DAY_LABELS.index(d) for d in off_days), other_pct)

# =============================================================================
# TRAIN / LOAD  +  shared calculations
# =============================================================================
bench = train_and_benchmark(raw_df, data_key, split_mode, int(n_trials))
model_name = bench["best_cv"] if model_choice.startswith("Auto") else model_choice

test = bench["test"]
t0 = test.index - pd.Timedelta(hours=1)
sdate = test["service_date"].values
month_ord = (test["service_date"].dt.year * 12 + test["service_date"].dt.month).values
pmask = peak_mask(t0, tariff)
md_mask = pmask if tariff.md_peak_only else np.ones(len(test), dtype=bool)

scale = building_peak_kw / raw_df["load"].max()
actual_kw = test["load"].values * scale
fc_kw = bench["pred"][model_name].values * scale
rel = bench["rel_resid"]
q_lo, q_hi = np.quantile(rel, [0.05, 0.95])
lo_kw, hi_kw = fc_kw * (1 + q_lo), fc_kw * (1 + q_hi)

bill_act = monthly_bill(actual_kw, month_ord, pmask, md_mask, tariff)
bill_fc = monthly_bill(fc_kw, month_ord, pmask, md_mask, tariff)
months = list(bill_act.index)
all_dates = sorted(test["service_date"].dt.date.unique())

step = max(1, int(building_peak_kw * 0.01))
max_shift = int(building_peak_kw * 0.5)
default_shift = max(step, int(building_peak_kw * 0.10) // step * step)

STRATEGY_UI = {
    "Load shifting": ("🔄 Shift to quiet hours",
                      "Move some usage (pre-cooling, pumps, EV charging …) from busy hours to quiet hours."),
    "Peak curtailment": ("🔌 Switch off for a while",
                         "Pause non-essential equipment during the busiest hours. Energy is saved, comfort may dip."),
    "MD capping": ("🎯 Stay under a limit",
                   "Keep demand under a ceiling so the monthly peak (Maximum Demand) charge goes down."),
}


def dr_params() -> dict:
    g = st.session_state.get
    return dict(strategy=g("s_dr_strategy", "Load shifting"),
                shift_kw=min(g("s_dr_shift", default_shift), max_shift),
                duration_h=g("s_dr_dur", 4), rebound_pct=g("s_dr_reb", 5), cap_pct=g("s_dr_cap", 8))


def run_dr(strategy=None, p=None):
    p = p or dr_params()
    s = strategy or p["strategy"]
    out, stats = apply_dr(fc_kw, sdate, month_ord, pmask, md_mask, s, p["shift_kw"], p["duration_h"],
                          p["rebound_pct"], p["cap_pct"])
    return out, monthly_bill(out, month_ord, pmask, md_mask, tariff), stats


def month_picker(where=None):
    host = where or st
    return persisted(host.selectbox, "Month", "month", months[min(5, len(months) - 1)], options=months,
                     format_func=month_name)


def next_hour_status(i: int, margin: float) -> dict:
    now = t0[i]
    known = (month_ord == month_ord[i]) & md_mask & (t0 < now)
    run_md = float(actual_kw[known].max()) if known.any() else np.nan
    nxt = float(fc_kw[i])
    p_ex = float(np.mean(rel > (run_md / nxt - 1.0))) if (md_mask[i] and not np.isnan(run_md)) else np.nan
    extra = 0.0
    if not md_mask[i]:
        tone, label = "ok", "Quiet period"
        msg = "The next hour is outside the peak-charge period, so it cannot raise your Maximum Demand charge."
    elif np.isnan(run_md):
        tone, label = "info", "New month"
        msg = "It is the start of the billing month, so this month's highest demand is still being set."
    elif nxt > run_md:
        extra = (nxt - run_md) * tariff.md_rate * (1 + tariff.other_pct / 100)
        tone, label = "alert", "Peak alert"
        msg = (f"Demand is expected to reach a new monthly high. That could add about <b>{rm(extra)}</b> to this "
               "month's bill. Try pausing flexible equipment (extra chillers, water pumps, EV chargers) for this hour.")
    elif nxt >= run_md * (1 - margin / 100):
        tone, label = "watch", "Getting high"
        msg = (f"Demand is close to this month's highest level ({run_md:,.0f} kW). "
               "Be ready to switch off flexible equipment if it keeps rising.")
    else:
        tone, label = "ok", "All good"
        msg = f"Demand is comfortably below this month's highest level ({run_md:,.0f} kW). No action needed."
    return dict(tone=tone, label=label, msg=msg, run_md=run_md, nxt=nxt, p=p_ex, extra=extra)


# =============================================================================
# TOP BAR + NAVIGATION
# =============================================================================
tariff_short = tariff.name.split(" – ")[0].split(" (")[0]
st.markdown(
    '<div class="topbar"><div class="brand"><div class="brand-badge">⚡</div><div>'
    '<div class="brand-name">Smart Grid Assistant</div>'
    '<div class="brand-sub">Know your demand • Avoid peak charges • Save money</div></div></div>'
    f'<div class="chips"><span class="chip">🏢 {building_peak_kw:,} kW building</span>'
    f'<span class="chip">🧾 Tariff {tariff_short}</span><span class="chip">🤖 {model_name}</span></div></div>',
    unsafe_allow_html=True)

NAV = ["🏠 Home", "📈 Usage", "💵 Bills", "💡 Savings", "🔔 Alerts", "🧠 AI Model"]
if "nav" not in st.session_state:
    st.session_state["nav"] = NAV[0]
if hasattr(st, "segmented_control"):
    choice = st.segmented_control("Navigate", NAV, key="nav", label_visibility="collapsed")
else:  # older Streamlit
    choice = st.radio("Navigate", NAV, key="nav", horizontal=True, label_visibility="collapsed")
page = choice or st.session_state.get("last_page", NAV[0])
st.session_state["last_page"] = page


def goto(p: str):
    st.session_state["nav"] = p


# =============================================================================
# PAGE: HOME
# =============================================================================
def page_home():
    with st.expander("🕒 Demo time – choose the moment the dashboard treats as “now”"):
        c1, c2 = st.columns(2)
        sel_date = persisted(c1.selectbox, "Date", "demo_date", all_dates[min(150, len(all_dates) - 1)],
                             options=all_dates)
        hour = persisted(c2.slider, "Hour of day", "demo_hour", 13, lo=0, hi=23)
    now = pd.Timestamp(sel_date) + pd.Timedelta(hours=hour)
    pos = np.flatnonzero(t0 == now)
    if len(pos) == 0:
        st.warning("No forecast is available for that moment. Pick another time.")
        return
    i = int(pos[0])
    margin = st.session_state.get("s_alert_margin", 3)
    s = next_hour_status(i, margin)
    cur_m = month_ord[i]

    left, right = st.columns([3, 2], gap="medium")
    with left:
        st.markdown(
            f'<div class="hero"><div class="hero-label">Next hour • {now:%a %d %b, %H:%M}</div>'
            f'<div class="hero-value">{s["nxt"]:,.0f}<span>kW expected</span></div>'
            f'{pill(s["label"], s["tone"])}<div class="hero-msg">{s["msg"]}</div></div>', unsafe_allow_html=True)
    with right:
        p_txt = "—" if np.isnan(s["p"]) else f"{s['p'] * 100:.0f} %"
        kpi("Chance of a new monthly peak", p_txt,
            "How likely the next hour is to beat this month's highest demand so far.")
        st.write("")
        kpi("Expected range", f"{lo_kw[i]:,.0f} – {hi_kw[i]:,.0f} kW",
            "9 out of 10 times, real demand lands inside this range.")

    section("This month at a glance", f"Billing month: {month_name(cur_m)}")
    k1, k2, k3 = st.columns(3, gap="medium")
    prev = bill_act["total_RM"].get(cur_m - 1, np.nan)
    est = bill_fc.loc[cur_m, "total_RM"]
    with k1:
        if np.isnan(prev):
            kpi("Estimated bill", rm(est), "Forecast for the whole month")
        else:
            d = (est / prev - 1) * 100
            kpi("Estimated bill", rm(est), f"{'▲' if d > 0 else '▼'} {abs(d):.1f}% vs last month",
                "bad" if d > 0 else "good")
    with k2:
        if np.isnan(s["run_md"]):
            kpi("Highest demand so far", "—", "Builds up as the month goes on")
        else:
            kpi("Highest demand so far", f"{s['run_md']:,.0f} kW",
                f"Sets your peak (MD) charge: about {rm(s['run_md'] * tariff.md_rate)}")
    with k3:
        _, ob, _ = run_dr()
        sv = bill_fc.loc[cur_m, "total_RM"] - ob.loc[cur_m, "total_RM"]
        sv_pct = sv / bill_fc.loc[cur_m, "total_RM"] * 100
        kpi("You could save", rm(max(sv, 0)), f"{max(sv_pct, 0):.1f}% this month with “{STRATEGY_UI[dr_params()['strategy']][0][2:].strip()}”", "good")

    section("Today so far", "Dark line = what was used • Orange dotted line = what the AI expected • Orange band = peak-rate hours")
    lo_i = max(0, i - 24)
    sl = slice(lo_i, i + 1)
    fig = go.Figure()
    shade_peaks(fig, t0[sl], pmask[sl])
    fig.add_trace(go.Scatter(x=t0[lo_i:i], y=actual_kw[lo_i:i], name="Actual", line=dict(color=THEME["navy"], width=3)))
    fig.add_trace(go.Scatter(x=t0[sl], y=fc_kw[sl], name="AI forecast", line=dict(color=THEME["primary"], dash="dot", width=2.5)))
    fig.add_trace(go.Scatter(x=[t0[i]], y=[s["nxt"]], mode="markers", name="Next hour",
                             marker=dict(size=14, color=TONE[s["tone"]], line=dict(color="#fff", width=2))))
    if not np.isnan(s["run_md"]):
        fig.add_hline(y=s["run_md"], line=dict(color=THEME["alert"], dash="dash"),
                      annotation_text="This month's highest", annotation_position="top left")
    fig.update_yaxes(title="kW")
    show_fig(fig, 320)

    section("What would you like to do?")
    q1, q2, q3, q4 = st.columns(4, gap="small")
    q1.button("📈 See my usage", on_click=goto, args=(NAV[1],), use_container_width=True)
    q2.button("💵 Understand my bill", on_click=goto, args=(NAV[2],), use_container_width=True)
    q3.button("💡 Plan my savings", on_click=goto, args=(NAV[3],), use_container_width=True)
    q4.button("🔔 Check alerts", on_click=goto, args=(NAV[4],), use_container_width=True)

    with st.expander("❓ New here? Quick guide and what the words mean"):
        st.markdown("""
**How to use this dashboard in 3 steps**
1. **Home** tells you what to expect in the next hour and whether you should act.
2. **Bills** shows what you pay and why. **Savings** lets you test ways to pay less.
3. **Alerts** lists the moments when demand got close to a new monthly peak.

**Words you will see**
- **kW (kilowatt)** – how much power you use *right now*. Think of it as the speed of a car.
- **kWh (kilowatt-hour)** – the total energy you used. Think of it as the distance travelled.
- **Maximum Demand (MD)** – your single highest kW in the month. TNB charges you for it, so **one busy hour can cost a lot**.
- **Peak / off-peak** – peak hours cost more per kWh and are when MD is measured. Off-peak hours are cheaper.
- **Forecast** – the AI's prediction for the next hour, based on recent usage, the time of day and the weather.
""")


# =============================================================================
# PAGE: USAGE
# =============================================================================
def page_usage():
    section("Your usage", "See how much power your building uses, by day or by month.")
    c1, c2, c3 = st.columns([1.2, 1, 1.6])
    sel_m = month_picker(c1)
    view = persisted(c2.radio, "View", "usage_view", "Day", options=["Day", "Month"], horizontal=True)
    mm = month_ord == sel_m
    days = sorted(test.loc[mm, "service_date"].dt.date.unique())

    if view == "Day":
        busiest = max(days, key=lambda d: actual_kw[sdate == np.datetime64(d)].max())
        sel_day = persisted(c3.selectbox, "Day", "usage_day", busiest, options=days)
        di = np.flatnonzero(sdate == np.datetime64(sel_day))
        a, f = actual_kw[di], fc_kw[di]
        pk = int(np.argmax(a))
        k1, k2, k3 = st.columns(3, gap="medium")
        with k1:
            peak_share = a[pmask[di]].sum() / a.sum() * 100 if a.sum() else 0
            kpi("Energy used", f"{a.sum():,.0f} kWh", f"{peak_share:.0f}% used during peak-rate hours")
        with k2:
            kpi("Highest demand", f"{a[pk]:,.0f} kW", f"at {t0[di][pk]:%H:%M}")
        with k3:
            kpi("Lowest demand", f"{a.min():,.0f} kW", f"at {t0[di][int(np.argmin(a))]:%H:%M}")
        section("Hour by hour", "Orange bars = peak-rate hours • Blue bars = off-peak hours • Dark line = AI forecast")
        fig = go.Figure()
        fig.add_trace(go.Bar(x=t0[di], y=a, name="Actual use",
                             marker_color=[THEME["primary"] if p else THEME["soft"] for p in pmask[di]]))
        fig.add_trace(go.Scatter(x=t0[di], y=f, name="AI forecast", line=dict(color=THEME["navy"], width=2.5)))
        fig.update_yaxes(title="kW")
        show_fig(fig)
        busy_h = t0[di][pk].hour
        note(f"💬 Your busiest hour was around <b>{busy_h:02d}:00</b> at <b>{a[pk]:,.0f} kW</b>. "
             + ("That is inside the peak-rate period, so it counts toward your Maximum Demand charge."
                if md_mask[di][pk] else "That is outside the peak-charge period, so it does not raise your MD charge."))
    else:
        dd = pd.DataFrame({"day": pd.to_datetime(sdate[mm]), "kWh": actual_kw[mm], "kW": actual_kw[mm]})
        g = dd.groupby("day").agg(kWh=("kWh", "sum"), peak=("kW", "max"))
        prev_mask = month_ord == (sel_m - 1)
        prev_kwh = actual_kw[prev_mask].sum() if prev_mask.any() else np.nan
        k1, k2, k3 = st.columns(3, gap="medium")
        with k1:
            if np.isnan(prev_kwh):
                kpi("Energy used", f"{g['kWh'].sum():,.0f} kWh", "")
            else:
                d = (g["kWh"].sum() / prev_kwh - 1) * 100
                kpi("Energy used", f"{g['kWh'].sum():,.0f} kWh", f"{'▲' if d > 0 else '▼'} {abs(d):.1f}% vs last month",
                    "bad" if d > 0 else "good")
        with k2:
            kpi("Average per day", f"{g['kWh'].mean():,.0f} kWh", f"{len(g)} days in this period")
        with k3:
            kpi("Highest demand", f"{g['peak'].max():,.0f} kW", f"on {g['peak'].idxmax():%d %b}")
        section("Day by day", "Each bar is one day's energy. The darkest bar is the busiest day.")
        top = g["kWh"].idxmax()
        fig = go.Figure(go.Bar(x=g.index, y=g["kWh"], name="Energy (kWh)",
                               marker_color=[THEME["navy"] if d == top else THEME["primary"] for d in g.index]))
        fig.update_yaxes(title="kWh per day")
        show_fig(fig)
        with st.expander("Show daily peak demand (actual vs AI forecast)"):
            gp = pd.DataFrame({"day": pd.to_datetime(sdate[mm]), "actual": actual_kw[mm], "forecast": fc_kw[mm],
                               "md": md_mask[mm]})
            gp = gp[gp["md"]].groupby("day")[["actual", "forecast"]].max()
            fig2 = go.Figure()
            fig2.add_trace(go.Bar(x=gp.index, y=gp["actual"], name="Actual daily peak", marker_color=THEME["soft"]))
            fig2.add_trace(go.Scatter(x=gp.index, y=gp["forecast"], name="AI forecast", mode="lines+markers",
                                      line=dict(color=THEME["primary"])))
            fig2.update_yaxes(title="kW")
            show_fig(fig2, 300)


# =============================================================================
# PAGE: BILLS
# =============================================================================
def page_bills():
    section("Your bill", "What you pay each month and why.")
    c1, _ = st.columns([1.2, 3])
    sel_m = month_picker(c1)
    b, f = bill_act.loc[sel_m], bill_fc.loc[sel_m]
    err = (f["total_RM"] / b["total_RM"] - 1) * 100

    left, right = st.columns([3, 2], gap="medium")
    with left:
        st.markdown(
            f'<div class="hero"><div class="hero-label">Bill for {month_name(sel_m)}</div>'
            f'<div class="hero-value">{rm(b["total_RM"])}</div>'
            f'<span class="pill">🤖 AI estimated {rm(f["total_RM"])} ({err:+.1f}%)</span>'
            f'<div class="hero-msg">Your Maximum Demand charge is <b>{b["MD_RM"] / b["total_RM"] * 100:.0f}%</b> of this bill. '
            f'It is decided by <b>one single hour</b> – the busiest one in the month ({b["MD_kW"]:,.0f} kW).</div></div>',
            unsafe_allow_html=True)
    with right:
        fig = px.pie(values=[b["energy_RM"], b["MD_RM"]], names=["Energy used", "Peak (MD) charge"], hole=0.62,
                     color_discrete_sequence=[THEME["soft"], THEME["primary"]])
        fig.update_traces(textinfo="percent", textfont_size=14, textposition="inside", insidetextorientation="horizontal")
        show_fig(fig, 250)

    section("Bill breakdown")
    other = (b["energy_RM"] + b["MD_RM"]) * tariff.other_pct / 100
    peak_cost, off_cost = b["peak_kWh"] * tariff.peak_rate, b["offpeak_kWh"] * tariff.offpeak_rate
    rows = [
        (f"Peak-hour energy<small>{b['peak_kWh']:,.0f} kWh × RM {tariff.peak_rate:.3f}</small>", peak_cost),
        (f"Off-peak energy<small>{b['offpeak_kWh']:,.0f} kWh × RM {tariff.offpeak_rate:.3f}</small>", off_cost),
        (f"Maximum Demand charge<small>{b['MD_kW']:,.0f} kW × RM {tariff.md_rate:.2f}</small>", b["MD_RM"]),
    ]
    if tariff.other_pct:
        rows.append((f"Other charges<small>{tariff.other_pct:.1f}% of the above</small>", other))
    rows.append(("Total", b["total_RM"]))
    html = "".join(f'<div class="line"><div>{n}</div><div>{rm(v)}</div></div>' for n, v in rows)
    st.markdown(f'<div class="card">{html}</div>', unsafe_allow_html=True)
    st.caption("Estimate based on your tariff settings. Real TNB bills can include extra items "
               "(e.g. KWTBB, service tax, power-factor).")

    section("Bill history", "Bars = actual • Line = what the AI estimated")
    hist = pd.DataFrame({"Month": [month_short(m) for m in months], "Energy": bill_act["energy_RM"].values,
                         "Peak (MD) charge": bill_act["MD_RM"].values, "AI estimate": bill_fc["total_RM"].values})
    fig = go.Figure()
    fig.add_trace(go.Bar(x=hist["Month"], y=hist["Energy"], name="Energy", marker_color=THEME["soft"]))
    fig.add_trace(go.Bar(x=hist["Month"], y=hist["Peak (MD) charge"], name="Peak (MD) charge", marker_color=THEME["primary"]))
    fig.add_trace(go.Scatter(x=hist["Month"], y=hist["AI estimate"], name="AI estimate", mode="lines+markers",
                             line=dict(color=THEME["navy"], width=2.5)))
    fig.update_layout(barmode="stack")
    fig.update_yaxes(title="RM")
    show_fig(fig)

    with st.expander("📄 Detailed table & download"):
        fin = pd.DataFrame({"Month": hist["Month"], "MD actual (kW)": bill_act["MD_kW"].values,
                            "MD forecast (kW)": bill_fc["MD_kW"].values, "Bill actual (RM)": bill_act["total_RM"].values,
                            "Bill forecast (RM)": bill_fc["total_RM"].values})
        fin["Bill error (%)"] = (fin["Bill forecast (RM)"] / fin["Bill actual (RM)"] - 1) * 100
        st.dataframe(fin.round(1), hide_index=True)
        st.download_button("⬇️ Download (CSV)", fin.round(2).to_csv(index=False).encode(),
                           file_name="monthly_bills.csv", mime="text/csv")


# =============================================================================
# PAGE: SAVINGS (demand response what-if)
# =============================================================================
def page_savings():
    section("Plan your savings", "Test ways to lower your peak and see what you would save. Nothing is switched automatically.")
    c1, _ = st.columns([1.2, 3])
    sel_m = month_picker(c1)

    st.markdown("**1 · Choose how you want to save**")
    strategy = persisted(st.radio, "Strategy", "dr_strategy", "Load shifting", options=list(STRATEGIES),
                         format_func=lambda s: STRATEGY_UI[s][0], horizontal=True, label_visibility="collapsed")
    st.caption(STRATEGY_UI[strategy][1])

    st.markdown("**2 · How much can you adjust?**")
    s1, s2 = st.columns(2, gap="large")
    with s1:
        shift_kw = persisted(st.slider, "Power you can move or switch off (kW)", "dr_shift", default_shift,
                             lo=0, hi=max_shift, step=step)
    with s2:
        duration_h = persisted(st.slider, "For how many hours a day?", "dr_dur", 4, lo=1, hi=8)
    with st.expander("More options"):
        o1, o2 = st.columns(2)
        with o1:
            rebound = persisted(st.slider, "Extra energy when catching up (%)", "dr_reb", 5, lo=0, hi=20,
                                help="Pre-cooling or catching up usually costs a little extra energy.")
        with o2:
            cap = persisted(st.slider, "Limit: how far below this month's peak? (%)", "dr_cap", 8, lo=1, hi=30,
                            help="Only used by “Stay under a limit”.")

    p = dr_params()
    opt_kw, ob, stats = run_dr()
    mb, mo = bill_fc.loc[sel_m], ob.loc[sel_m]
    saving = mb["total_RM"] - mo["total_RM"]
    pct = saving / mb["total_RM"] * 100 if mb["total_RM"] else 0

    st.markdown("**3 · Your result**")
    r1, r2 = st.columns([3, 2], gap="medium")
    with r1:
        if saving > 0.5:
            st.markdown(
                f'<div class="save-card"><div class="kpi-label">You could save in {month_name(sel_m)}</div>'
                f'<div class="save-big">{rm(saving)} <span style="font-size:18px">({pct:.1f}%)</span></div>'
                f'<div class="kpi-sub" style="margin-top:8px;font-size:14px">Your peak demand drops from '
                f'<b>{mb["MD_kW"]:,.0f} kW</b> to <b>{mo["MD_kW"]:,.0f} kW</b> and your bill from '
                f'<b>{rm(mb["total_RM"])}</b> to <b>{rm(mo["total_RM"])}</b>.</div></div>', unsafe_allow_html=True)
        else:
            st.markdown(
                '<div class="card"><p>⚠️ These settings do not lower this month\'s <b>highest</b> peak, so there is no '
                'saving yet. Try moving more power, for more hours, or choose <b>Stay under a limit</b>.</p></div>',
                unsafe_allow_html=True)
    with r2:
        kpi("Energy moved or saved each month", f"{stats['shaved_kWh'] / max(len(months), 1):,.0f} kWh",
            "Average over the months in the test period")

    section("A typical busy day", "Dark line = before • Green line = after your change • Orange band = peak-rate hours")
    mmask = month_ord == sel_m
    days = sorted(test.loc[mmask, "service_date"].dt.date.unique())
    day_pk = {d: fc_kw[(sdate == np.datetime64(d)) & md_mask].max() if ((sdate == np.datetime64(d)) & md_mask).any() else 0
              for d in days}
    best = max(day_pk, key=day_pk.get)
    sel_day = persisted(st.selectbox, "Day to show", "sav_day", best, options=days)
    di = np.flatnonzero(sdate == np.datetime64(sel_day))
    fig = go.Figure()
    shade_peaks(fig, t0[di], pmask[di])
    fig.add_trace(go.Scatter(x=t0[di], y=fc_kw[di], name="Before", line=dict(color=THEME["navy"], width=3)))
    fig.add_trace(go.Scatter(x=t0[di], y=opt_kw[di], name="After", line=dict(color=THEME["ok"], width=3.5)))
    fig.update_yaxes(title="kW")
    show_fig(fig, 320)
    if not md_mask.all() and not pmask[di].any():
        st.info("This day is entirely off-peak under your tariff, so there is nothing to shift.")

    section("Compare the three ways to save", f"For {month_name(sel_m)} with your current settings")
    rows = []
    for s in STRATEGIES:
        _, b2, _ = run_dr(s)
        rows.append({"Way to save": STRATEGY_UI[s][0], "Saving (RM)": mb["total_RM"] - b2.loc[sel_m, "total_RM"],
                     "Peak (kW)": b2.loc[sel_m, "MD_kW"]})
    comp = pd.DataFrame(rows)
    fig = px.bar(comp, x="Saving (RM)", y="Way to save", orientation="h",
                 text=comp["Saving (RM)"].map(lambda v: f"RM {v:,.0f}"), color_discrete_sequence=[THEME["ok"]])
    fig.update_traces(textposition="outside", cliponaxis=False)
    fig.update_yaxes(title="", autorange="reversed")
    fig.update_xaxes(range=[0, max(float(comp["Saving (RM)"].max()), 1.0) * 1.25])
    show_fig(fig, 230)
    if stats["unrecovered_kWh"] > 1:
        st.caption("Some shifted energy could not be recovered in quiet hours within your power limit "
                   "(it is counted as switched off).")

    with st.expander("📆 Savings across all months"):
        base_total = bill_fc["total_RM"].sum()
        allrows = []
        for s in STRATEGIES:
            _, b3, _ = run_dr(s)
            allrows.append({"Way to save": STRATEGY_UI[s][0], "Bill before (RM)": base_total,
                            "Bill after (RM)": b3["total_RM"].sum(), "Saving (RM)": base_total - b3["total_RM"].sum(),
                            "Saving (%)": (base_total - b3["total_RM"].sum()) / base_total * 100})
        st.dataframe(pd.DataFrame(allrows).round(1), hide_index=True)


# =============================================================================
# PAGE: ALERTS
# =============================================================================
def page_alerts():
    section("Peak alerts", "Moments when the AI expected demand to reach or approach this month's highest level.")
    c1, c2 = st.columns([1.2, 3])
    sel_m = month_picker(c1)
    with c2.expander("Make alerts more or less sensitive"):
        margin = persisted(st.slider, "Warn me when the forecast is within … % of the month's highest demand",
                           "alert_margin", 3, lo=0, hi=15)
    mm = month_ord == sel_m
    sub = pd.DataFrame({"t0": t0[mm], "forecast_kW": fc_kw[mm], "actual_kW": actual_kw[mm], "md": md_mask[mm]})
    act_md = sub["actual_kW"].where(sub["md"], -np.inf)
    sub["running"] = act_md.cummax().shift(1).replace(-np.inf, np.nan)
    valid = sub["md"] & sub["running"].notna() & (np.arange(len(sub)) >= 24)
    sub["alert"] = valid & (sub["forecast_kW"] > sub["running"] * (1 - margin / 100))
    sub["real"] = valid & (sub["actual_kW"] > sub["running"])
    tp = int((sub["alert"] & sub["real"]).sum())
    n_alert, n_true = int(sub["alert"].sum()), int(sub["real"].sum())

    k1, k2, k3 = st.columns(3, gap="medium")
    with k1:
        kpi("Alerts this month", f"{n_alert}", "Times the AI warned you")
    with k2:
        kpi("Peaks caught", "—" if n_true == 0 else f"{tp / n_true * 100:.0f}%",
            "" if n_true == 0 else f"{tp} of {n_true} real new highs were flagged beforehand", "good")
    with k3:
        kpi("Alerts that were real", "—" if n_alert == 0 else f"{tp / n_alert * 100:.0f}%",
            "Some alerts are ‘better safe than sorry’")

    section("Recent alerts")
    al = sub[sub["alert"]].sort_values("t0", ascending=False)
    if al.empty:
        note("🎉 No alerts this month – demand stayed comfortably below the monthly peak.")
    else:
        html = ""
        for _, r in al.head(12).iterrows():
            red = r["forecast_kW"] > r["running"]
            tag = f'<span class="tag" style="background:{TONE["alert"] if red else TONE["watch"]}">{"Peak alert" if red else "Getting high"}</span>'
            happened = "✅ It really did hit a new monthly high" if r["real"] else "ℹ️ It stayed below the monthly high"
            html += (f'<div class="row"><div><div class="row-main">{r["t0"]:%a %d %b, %H:%M}</div>'
                     f'<div class="row-sub">Expected {r["forecast_kW"]:,.0f} kW vs month high {r["running"]:,.0f} kW • {happened}</div></div>{tag}</div>')
        st.markdown(html, unsafe_allow_html=True)
        if len(al) > 12:
            with st.expander(f"Show all {len(al)} alerts"):
                st.dataframe(al[["t0", "forecast_kW", "running", "actual_kW", "real"]].round(1)
                             .rename(columns={"t0": "Time", "forecast_kW": "Forecast (kW)", "running": "Month high so far (kW)",
                                              "actual_kW": "Actual (kW)", "real": "New high really happened"}),
                             hide_index=True)

    with st.expander("How do alerts work?"):
        st.markdown("Each hour, the AI forecasts the *next* hour using only readings that already exist. "
                    "If that forecast is near or above the highest demand recorded so far this month (during the "
                    "peak-charge period), it raises an alert, because a new monthly high raises your Maximum Demand charge.")


# =============================================================================
# PAGE: AI MODEL (for analysts / examiners)
# =============================================================================
def page_ai():
    section("Under the hood", "For analysts and examiners: how the AI was built and how well it performs.")
    t_models, t_data = st.tabs(["Model comparison", "Data & assumptions"])
    with t_models:
        tm, cvm = bench["test_metrics"].copy(), bench["cv_metrics"].copy()
        tm["Type"] = ["Model" if n in MODEL_NAMES else "Baseline" for n in tm.index]
        k1, k2, k3 = st.columns(3, gap="medium")
        with k1:
            kpi("Selected (validation)", bench["best_cv"], "Lowest RMSE on validation folds")
        with k2:
            kpi("Best on test set", bench["best_test"], f"RMSE {tm.loc[bench['best_test'], 'RMSE']:.1f} MW")
        with k3:
            kpi("In use", model_name, f"R² {tm.loc[model_name, 'R2']:.4f} • MAPE {tm.loc[model_name, 'MAPE_%']:.2f}%")
        st.caption("Models are selected on cross-validation inside the training period, so the test set stays untouched. "
                   "Errors are in MW (utility scale).")
        st.dataframe(tm.sort_values("RMSE").round(3), column_config={"MAPE_%": "MAPE (%)"})
        b1, b2 = st.columns(2)
        with b1:
            show_fig(px.bar(tm.reset_index().rename(columns={"index": "Model"}), x="Model", y="RMSE", color="Type", color_discrete_map={"Model": THEME["primary"], "Baseline": THEME["soft"]},
                            title="Test RMSE (MW) – lower is better"), 300)
        with b2:
            show_fig(px.bar(tm.reset_index().rename(columns={"index": "Model"}), x="Model", y="MAE", color="Type", color_discrete_map={"Model": THEME["primary"], "Baseline": THEME["soft"]},
                            title="Test MAE (MW) – lower is better"), 300)
        st.markdown("**Validation (expanding-window CV, last 2 folds of the training period)**")
        st.dataframe(cvm.round(3))
        if bench["tuning"]:
            st.markdown("**Bayesian (Optuna TPE) tuned hyper-parameters**")
            st.json({k: {pk: (round(pv, 4) if isinstance(pv, float) else pv) for pk, pv in v.items()}
                     for k, v in bench["params"].items()})
        else:
            st.caption("Default hyper-parameters in use. Turn on Bayesian tuning in the sidebar (Stage 6 of the methodology).")
        st.markdown("**Peak-period detection** (peak hour = load ≥ the 90th percentile of the training data)")
        st.dataframe(bench["peak"].round(3))

        st.markdown("**Actual vs predicted**")
        dmin, dmax = test.index.min().date(), test.index.max().date()
        w1, w2 = st.columns(2)
        rng = w1.slider("Window (days)", 1, 28, 7, key="bench_win")
        start = w2.date_input("Start date", value=dmin + pd.Timedelta(days=min(150, max(0, (dmax - dmin).days - rng))),
                              min_value=dmin, max_value=dmax, key="bench_start")
        w = (test.index >= pd.Timestamp(start)) & (test.index < pd.Timestamp(start) + pd.Timedelta(days=rng))
        figp = go.Figure()
        figp.add_trace(go.Scatter(x=test.index[w], y=test["load"][w], name="Actual", line=dict(color="black", width=2)))
        for n in MODEL_NAMES:
            figp.add_trace(go.Scatter(x=test.index[w], y=bench["pred"][n][w], name=n, opacity=0.85))
        figp.update_yaxes(title="MW")
        show_fig(figp)
        e1, e2 = st.columns(2)
        with e1:
            err = pd.DataFrame({n: np.abs(test["load"].values - bench["pred"][n].values) for n in MODEL_NAMES},
                               index=test.index)
            show_fig(px.line(err.groupby(t0.hour).mean(), title="MAE by hour of day (MW)",
                             labels={"value": "MAE (MW)", "index": "hour"}), 300)
        with e2:
            imp = bench["importance"][model_name].sort_values().tail(15)
            show_fig(px.bar(imp, orientation="h", title=f"Top features – {model_name}",
                            labels={"value": "importance", "index": ""}), 300)

    with t_data:
        st.caption(f"Source: {source_name}")
        st.dataframe(pd.DataFrame({"Check / fix": list(cleaning_report), "Count": list(cleaning_report.values())}),
                     hide_index=True)
        show_fig(px.line(raw_df["load"].resample("D").mean(), title="Daily mean load (MW) – whole dataset",
                         labels={"value": "MW", "index": ""}), 300)
        st.markdown("**Tariff in use**")
        st.dataframe(pd.DataFrame({
            "Item": ["Tariff", "MD charge", "Peak energy", "Off-peak energy", "MD measured", "Peak period",
                     "Off-peak days", "Other charges"],
            "Value": [tariff.name, f"RM {tariff.md_rate:.2f}/kW/month", f"RM {tariff.peak_rate:.3f}/kWh",
                      f"RM {tariff.offpeak_rate:.3f}/kWh", "peak period only" if tariff.md_peak_only else "all hours",
                      f"{tariff.peak_start:02d}:00–{tariff.peak_end:02d}:00",
                      ", ".join(DAY_LABELS[d] for d in tariff.offpeak_days) or "none", f"{tariff.other_pct:.1f} %"]}),
            hide_index=True)
        st.markdown(f"""
**Key assumptions (cite these in the report)**
- **Building scaling.** The SEWA data is a *utility-level* load (≈{raw_df['load'].min():,.0f}–{raw_df['load'].max():,.0f} MW).
  Its shape is rescaled so the highest hour equals the building peak you set ({building_peak_kw:,} kW). Replace it with the
  building's own smart-meter data for real deployment.
- **Forecast task.** Hour-ahead (one-step) forecasting: at each hour the model sees actual readings up to the previous hour.
  Weather inputs are the daily values in the workbook and are treated as a weather-forecast proxy.
- **Maximum Demand** is billed on the highest 30-minute demand; this dashboard uses hourly averages, so it slightly
  *under*-estimates MD. MD is charged monthly – savings only appear if the **monthly** maximum falls.
- **Tariff.** C1/C2 rates follow TNB's published commercial schedule. TNB restructured non-domestic tariffs on
  1 July 2025 (capacity/network components); edit the rates in the sidebar to match your latest bill. Public holidays are
  not modelled as off-peak; KWTBB/service tax/ICPT/power-factor penalties are excluded unless you add an "other %".
- **Validation.** Model selection uses time-series CV on the training period; the test period is never used for tuning.
- **Scope.** The system recommends actions only – no automatic device actuation.
""")


PAGES = {NAV[0]: page_home, NAV[1]: page_usage, NAV[2]: page_bills, NAV[3]: page_savings,
         NAV[4]: page_alerts, NAV[5]: page_ai}
PAGES[page]()
