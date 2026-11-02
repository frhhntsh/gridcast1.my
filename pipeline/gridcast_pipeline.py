"""
GridCast.my - training & export pipeline
========================================
Cleans the SEWA workbook, builds features, benchmarks XGBoost / CatBoost / LightGBM
(plus a simple XGBoost+LightGBM blend) and exports everything the static web app needs
to  ../public/data/gridcast_data.json

Usage:
    python gridcast_pipeline.py --excel "SEWA Electricity Demand Forecasting (Checked) - 2020&2021.xlsx"
    python gridcast_pipeline.py --excel ... --trials 25      # Bayesian (Optuna) tuning, slower
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import io
import warnings
from pathlib import Path

import catboost as cb
import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import (mean_absolute_error, mean_squared_error,
                             precision_recall_fscore_support, r2_score)
from sklearn.model_selection import TimeSeriesSplit

warnings.filterwarnings("ignore")
try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except Exception:  # optional
    HAS_OPTUNA = False

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




def _clean_time_label(v) -> bool:
    if isinstance(v, dt.time):
        return v.minute == 0 and v.second == 0
    return bool(re.fullmatch(r"\d{1,2}[: ]00(:00)?", str(v).strip()))


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


def train_and_benchmark(_data: pd.DataFrame, split_mode: str, n_trials: int):
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
# EXPORT FOR THE WEB APP
# =============================================================================
BLEND = "Blend (XGBoost + LightGBM)"


def oof_relative_residuals(name, params, X, y):
    rel = []
    for tr, va in late_folds(len(X)):
        m = build_model(name, params).fit(X.iloc[tr], y.iloc[tr])
        rel.append(y.iloc[va].values / m.predict(X.iloc[va]) - 1.0)
    return np.concatenate(rel)


def day_block_bootstrap(y, p_a, p_b, days, n=5000, seed=0):
    """Paired day-block bootstrap of (error of B) - (error of A). Positive => A is better."""
    codes = pd.Series(days).factorize()[0]
    nd = codes.max() + 1
    out = {}
    for tag, fa, fb in (("mse", (y - p_a) ** 2, (y - p_b) ** 2), ("mae", np.abs(y - p_a), np.abs(y - p_b))):
        d = pd.Series(fb - fa).groupby(codes).mean().values
        rng = np.random.default_rng(seed)
        bs = np.array([rng.choice(d, nd).mean() for _ in range(n)])
        out[tag] = {"mean_diff": float(d.mean()), "ci95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                    "share_days_A_better": float((d > 0).mean())}
    return out


def build_export(raw, report, bench, trials):
    test, train = bench["test"], bench["train"]
    features = bench["features"]
    Xtr, ytr = train[features], train["load"]
    y = test["load"].values
    t0 = test.index - pd.Timedelta(hours=1)
    assert len(test) == 8760 and t0[0] == pd.Timestamp("2021-01-01 00:00"), "expected one full 2021 test year"

    preds = {n: bench["pred"][n].values for n in MODEL_NAMES}
    preds[BLEND] = (preds["XGBoost"] + preds["LightGBM"]) / 2
    names = MODEL_NAMES + [BLEND]

    rel_q = {}
    for n in MODEL_NAMES:
        rel = oof_relative_residuals(n, bench["params"][n], Xtr, ytr)
        rel_q[n] = np.quantile(rel, np.linspace(0.01, 0.99, 99)).round(5).tolist()
    # blend residuals: average the two OOF predictions fold by fold
    rel_b = []
    for tr, va in late_folds(len(Xtr)):
        pa = build_model("XGBoost", bench["params"]["XGBoost"]).fit(Xtr.iloc[tr], ytr.iloc[tr]).predict(Xtr.iloc[va])
        pb = build_model("LightGBM", bench["params"]["LightGBM"]).fit(Xtr.iloc[tr], ytr.iloc[tr]).predict(Xtr.iloc[va])
        rel_b.append(ytr.iloc[va].values / ((pa + pb) / 2) - 1.0)
    rel_q[BLEND] = np.quantile(np.concatenate(rel_b), np.linspace(0.01, 0.99, 99)).round(5).tolist()

    test_metrics = {n: evaluate(y, preds[n]) for n in names}
    for k in ("Naive (lag-1)", "Seasonal naive (lag-24)", "Seasonal naive (lag-168)"):
        test_metrics[k] = bench["test_metrics"].loc[k].to_dict()
    cv_metrics = bench["cv_metrics"].to_dict("index")

    # validation fold scores for the blend
    cv_b = []
    for tr, va in late_folds(len(Xtr)):
        pa = build_model("XGBoost", bench["params"]["XGBoost"]).fit(Xtr.iloc[tr], ytr.iloc[tr]).predict(Xtr.iloc[va])
        pb = build_model("LightGBM", bench["params"]["LightGBM"]).fit(Xtr.iloc[tr], ytr.iloc[tr]).predict(Xtr.iloc[va])
        cv_b.append(evaluate(ytr.iloc[va], (pa + pb) / 2))
    cv_metrics[BLEND] = pd.DataFrame(cv_b).mean().to_dict()

    thr = bench["peak_threshold_MW"]
    peak = {n: peak_detection(y, preds[n], t0, thr) for n in names}
    for k in ("Naive (lag-1)", "Seasonal naive (lag-24)", "Seasonal naive (lag-168)"):
        peak[k] = bench["peak"].loc[k].to_dict()

    hourly_mae = {n: pd.Series(np.abs(y - preds[n])).groupby(np.asarray(t0.hour)).mean().round(3).tolist() for n in names}
    mon = np.asarray(t0.month)
    monthly_mape = {n: [float(np.mean(np.abs((y - preds[n]) / y)[mon == m]) * 100) for m in range(1, 13)] for n in names}

    boot = day_block_bootstrap(y, preds["XGBoost"], preds["LightGBM"], np.asarray(t0.normalize()))
    imp = bench["importance"]["XGBoost"].sort_values(ascending=False).head(15)

    wx = (test.assign(d=t0.normalize()).groupby("d")[["Temp", "Hum", "MAX Tem", "Min Tem"]].first())
    return {
        "meta": {
            "product": "GridCast.my", "generated": dt.datetime.now().isoformat(timespec="seconds"),
            "source": "SEWA hourly electricity demand 2020-2021 (Jawad et al., 2024, Data in Brief 52)",
            "split": "train 2020 -> test 2021", "t0_start": "2021-01-01T00:00", "hours": int(len(test)),
            "ref_peak_mw": float(raw["load"].max()), "min_mw": float(raw["load"].min()),
            "train_hours": int(len(train)), "train_range": [str(train.index.min()), str(train.index.max())],
            "features": features, "default_model": "XGBoost", "models": names,
            "peak_threshold_mw": float(thr), "bayesian_trials": int(trials),
            "params": {k: v for k, v in bench["params"].items()},
        },
        "actual_mw": np.round(y, 2).tolist(),
        "forecast_mw": {n: np.round(preds[n], 2).tolist() for n in names},
        "rel_q": rel_q,
        "weather_daily": {"temp": wx["Temp"].round(1).tolist(), "hum": wx["Hum"].round(0).tolist(),
                          "tmax": wx["MAX Tem"].round(1).tolist(), "tmin": wx["Min Tem"].round(1).tolist()},
        "benchmark": {"test": test_metrics, "validation": cv_metrics, "peak": peak, "hourly_mae": hourly_mae,
                      "monthly_mape": monthly_mape, "importance_xgb": imp.round(4).to_dict(),
                      "xgb_vs_lgbm_bootstrap": boot, "best_cv_single": bench["best_cv"], "best_test_single": bench["best_test"]},
        "data_quality": report,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--excel", required=True)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public" / "data" / "gridcast_data.json"))
    ap.add_argument("--trials", type=int, default=0, help="Optuna trials per model (0 = default hyper-parameters)")
    a = ap.parse_args()
    raw, report = load_dataset(Path(a.excel).read_bytes())
    print("dataset:", raw.shape, report)
    bench = train_and_benchmark(raw, "Proposal split: train 2020 → test 2021", a.trials)
    print(bench["test_metrics"].round(3))
    data = build_export(raw, report, bench, a.trials)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(data, separators=(",", ":")))
    print("wrote", a.out, round(Path(a.out).stat().st_size / 1024), "KB")


if __name__ == "__main__":
    main()
