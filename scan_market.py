#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
全市场 ETF 国家队持仓扫描
- 沪市 ETF 代码：枚举 51/56/58/59 开头主力段，用新浪接口做存在性探测
- 深市 ETF 代码：枚举 159000-159999 / 160000-169999，用新浪接口做存在性探测
- 对每个代码查询新浪十大持有人(2026-03-31)，筛出含 汇金投资/汇金资管/国新/诚通 任一主体的 ETF
- 并发控制 + 重试 + 超时，结果存 scan_market.json
"""
import json, urllib.request, urllib.error, time, os
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.abspath(__file__))
REPORT_DATE = "2026-03-31"
BODIES = ["汇金投资", "汇金资产管理", "国新", "诚通"]
EXISTING = {  # 当前已在追踪的40只
    "510330","510300","510310","159919","510050","510180","510500","512500","159922",
    "515800","560010","512100","159845","159629","159915","159952","159977","588080",
    "588050","159901","560050","510230","159931","159851","516860","512660","516110",
    "159995","515790","512010","512690","515170","159865","512170","159605","513050",
    "512400","515210","159870","511860",
}

def http_get_json(url, timeout=8, retries=1):
    last = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://finance.sina.com.cn/",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            return json.loads(raw)
        except Exception as e:
            last = e
            time.sleep(0.2)
    return None

def gen_sh_candidates():
    """沪市 ETF 代码枚举：51/56/58/59 开头的主力段"""
    segs = [
        (510000, 7000),   # 510000-516999 宽基/行业/主题
        (518000, 1000),   # 商品(黄金)
        (560000, 2000),   # 中证/双创系列
        (563000, 1000),   # 主题
        (588000, 2000),   # 科创板系列
    ]
    codes = []
    for base, n in segs:
        for i in range(n):
            codes.append(f"{base + i:06d}")
    return [(c, "") for c in codes]

def gen_sz_candidates():
    """深市候选：159000-159999, 160000-169999"""
    codes = []
    for base in (159000, 160000):
        for i in range(1000):
            codes.append(f"{base + i:06d}")
    return [(c, "") for c in codes]

def check_holder(code):
    """返回 (code, exists, hits) ；hits=[(name, pct)]"""
    url = (f"https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/"
           f"CaihuiFundInfoService.getFundHolder?symbol={code}&date={REPORT_DATE}")
    j = http_get_json(url)
    if not j:
        return (code, False, [])
    rows = (j.get("result") or {}).get("data") or []
    if not rows:
        return (code, False, [])
    hits = []
    for r in rows:
        nm = r.get("cyrmc", "") or ""
        if any(b in nm for b in BODIES):
            try:
                pct = float(r.get("zfeb") or 0)
            except (TypeError, ValueError):
                pct = 0.0
            hits.append((nm, pct))
    return (code, True, hits)

def market_of(code):
    return "SH" if code[:1] == "5" else "SZ"

def main():
    sh = gen_sh_candidates()
    sz = gen_sz_candidates()
    # 合并去重，保留市场来源
    all_codes = {}
    for c, n in sh + sz:
        all_codes.setdefault(c, n)
    # 排除已追踪
    todo = [c for c in all_codes if c not in EXISTING]
    print(f"沪市枚举: {len(sh)}  深市枚举: {len(sz)}  去重后待扫(排除40只): {len(todo)}", flush=True)

    results = {}        # code -> {name, market, exists, hits}
    hits = {}           # code -> [(name,pct)]
    done = 0
    total = len(todo)
    t0 = time.time()

    def worker(code):
        name = all_codes.get(code, "")
        _, exists, h = check_holder(code)
        return code, name, exists, h

    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(worker, c): c for c in todo}
        for fut in as_completed(futs):
            code, name, exists, h = fut.result()
            results[code] = {"name": name, "market": market_of(code),
                             "exists": exists, "hits": h}
            if h:
                hits[code] = h
            done += 1
            if done % 200 == 0:
                el = time.time() - t0
                print(f"  进度 {done}/{total}  命中 {len(hits)}  耗时 {el:.0f}s", flush=True)

    out = {
        "report_date": REPORT_DATE,
        "bodies": BODIES,
        "scanned_total": total,
        "existing_excluded": sorted(EXISTING),
        "hits": {c: [{"name": n, "pct": p} for n, p in v] for c, v in hits.items()},
        "all_results": results,
    }
    with open(os.path.join(ROOT, "scan_market.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    # 汇总打印
    print("\n===== 扫描完成 =====", flush=True)
    print(f"扫描总数(排除已追踪): {total}", flush=True)
    print(f"命中国家队持仓的ETF数量: {len(hits)}", flush=True)
    print("命中清单(按占比降序):", flush=True)
    for c, v in sorted(hits.items(), key=lambda kv: -max(p for _, p in kv[1])):
        nm = results[c]["name"] or "(名称待查)"
        mk = results[c]["market"]
        s = "; ".join(f"{n}({p}%)" for n, p in v)
        print(f"  {mk} {c} {nm}: {s}", flush=True)

if __name__ == "__main__":
    main()
