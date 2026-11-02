"""Independent Python reference: compares the JS engine with the tested Python engine (from the Streamlit prototype)."""
import json, sys, numpy as np, pandas as pd
src = open("../legacy_streamlit/app.py").read().split("# DATA LOADING")[0].replace("st.set_page_config(", "(lambda **k: None)(")
ns = {}; exec(src, ns)
apply_dr = ns["apply_dr"]
data = json.load(open("../public/data/gridcast_data.json")); js = json.load(open("js_out.json"))
N = 8760
t0 = pd.date_range("2021-01-01", periods=N, freq="h")
sdate = t0.normalize().values
month = np.asarray(t0.month); month_ord = 2021 * 12 + month
PRE = {
 "mvtou": dict(ep=.3132, eo=.2723, cap=30.19, net=66.87, ret=200, afa=3.61, md_peak_only=True, ps=14, pe=22),
 "mvgen": dict(ep=.2983, eo=.2983, cap=29.43, net=59.84, ret=200, afa=3.61, md_peak_only=False, ps=14, pe=22),
 "c2legacy": dict(ep=.365, eo=.224, cap=45.10, net=0, ret=0, afa=0, md_peak_only=True, ps=8, pe=22),
}
SC = {"tou_shift": ("mvtou", 2000, "Load shifting", 200, 4, 5, 8), "gen_cap": ("mvgen", 3500, "MD capping", 400, 4, 5, 8),
      "legacy_curtail": ("c2legacy", 1200, "Peak curtailment", 150, 3, 0, 8), "gen_shift": ("mvgen", 2000, "Load shifting", 300, 5, 10, 8)}
def bills(load, pm, md, T, other=1.6):
    r = []
    for m in range(1, 13):
        s = month == m
        pk, off = load[s & pm].sum(), load[s & ~pm].sum()
        mdkw = load[s & md].max()
        sub = pk*T["ep"] + off*T["eo"] + (pk+off)*T["afa"]/100 + mdkw*(T["cap"]+T["net"]) + T["ret"]
        r.append((sub*(1+other/100), mdkw))
    return r
worst = 0
for name, (tid, peak, strat, flex, hrs, reb, cap) in SC.items():
    T = PRE[tid]; k = peak / data["meta"]["ref_peak_mw"]
    fc = np.array(data["forecast_mw"]["XGBoost"]) * k; act = np.array(data["actual_mw"]) * k
    pm = (t0.hour >= T["ps"]) & (t0.hour < T["pe"]) & ~np.isin(t0.dayofweek, [5, 6]); pm = np.asarray(pm)
    md = pm if T["md_peak_only"] else np.ones(N, bool)
    b0 = bills(act, pm, md, T)
    out, st = apply_dr(fc, sdate, month_ord, pm, md, strat, flex, hrs, reb, cap)
    b1 = bills(out, pm, md, T)
    J = js[name]
    d_base = max(abs(a[0]-b) for a, b in zip(b0, J["baseTotals"]))
    d_after = max(abs(a[0]-b) for a, b in zip(b1, J["afterTotals"]))
    d_md = max(abs(a[1]-b) for a, b in zip(b1, J["afterMd"]))
    d_arr = np.abs(out - np.array(J["drOut"])).max()
    d_stat = abs(st["shaved_kWh"] - J["stats"]["shavedKwh"])
    worst = max(worst, d_base, d_after, d_md, d_arr)
    print(f"{name:15s} base bill Δ {d_base:.6f} | after bill Δ {d_after:.6f} | MD Δ {d_md:.6f} | DR curve max Δ {d_arr:.6f} | shaved Δ {d_stat:.6f}")
print("WORST DIFFERENCE:", worst)
print("date mapping:", js["mapping"])
