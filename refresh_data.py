# -*- coding: utf-8 -*-
"""
refresh_data.py — 真实数据刷新脚本（零第三方依赖，仅用 Python 标准库）

数据来源（全部为公开接口，K线优先级：新浪 → 东财 → 腾讯 → 通达信）：
  1) 新浪财经 money.finance.sina.com.cn（主源）：ETF/指数日线（收盘价 + 成交量；
     ETF 成交额用 量×均价 估算，与东财真实值误差 <0.01%；注意：新浪日线为不复权）
  2) 东方财富 push2his（备源 + 指数成交额补缺）：指数真实成交额仅东财提供
  3) 腾讯 web.ifzq.gtimg.cn（兜底备源）
  3b) 通达信行情服务器（海外兜底备源，纯 socket 协议，零依赖）：当新浪/东财/腾讯
      在境外 IP 被墙时启用；提供 SH/SZ 指数与全部 ETF 的真实收盘价与真实成交额
      （不复权）。中证 2.xxx / 国证 980xxx 指数通达信指数库不含，无法覆盖。
  4) 上交所 query.sse.com.cn：沪市 ETF 每日总份额（万份）
  5) 深交所 investor.szse.cn：深市 ETF 历史规模 fund_jjgm（万份；支持全量历史，
     内部按 ~90 天分段查询+翻页）
  6) disclosures.json：汇金/证金季报披露数据（人工维护，脚本自动合并）

产物：data.js（window.APP_DATA = ...）与 data.json（同一对象，供 /api/refresh 热重载）

用法：
  python refresh_data.py                 # 增量刷新（份额只补缺失日期）
  python refresh_data.py --backfill 120  # 回补最近 120 个交易日的真实份额
"""
import argparse
import io
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
import zipfile
import zlib
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))

# ---------------- 配置 ----------------
# code, name, group, index_key, manager
ETFS = [
    # —— 宽基 ——
    ("510330", "沪深300ETF华夏", "宽基/沪深300", "hs300", "华夏基金"),
    ("510300", "沪深300ETF华泰柏瑞", "宽基/沪深300", "hs300", "华泰柏瑞"),
    ("510310", "沪深300ETF易方达", "宽基/沪深300", "hs300", "易方达"),
    ("159919", "沪深300ETF嘉实", "宽基/沪深300", "hs300", "嘉实基金"),
    ("510050", "上证50ETF华夏", "宽基/上证50", "sse50", "华夏基金"),
    ("510180", "上证180ETF华安", "宽基/上证180", "sse180", "华安基金"),
    ("510500", "中证500ETF南方", "宽基/中证500", "csi500", "南方基金"),
    ("512500", "华夏中证500ETF", "宽基/中证500", "csi500", "华夏基金"),
    ("159922", "中证500ETF嘉实", "宽基/中证500", "csi500", "嘉实基金"),
    ("515800", "中证800ETF汇添富", "宽基/中证800", "csi800", "汇添富"),
    ("560010", "中证1000ETF广发", "宽基/中证1000", "csi1000", "广发基金"),
    ("512100", "中证1000ETF南方", "宽基/中证1000", "csi1000", "南方基金"),
    ("159845", "华夏中证1000ETF", "宽基/中证1000", "csi1000", "华夏基金"),
    ("159629", "中证1000ETF富国", "宽基/中证1000", "csi1000", "富国基金"),
    ("159915", "创业板ETF易方达", "宽基/创业板", "chinext", "易方达"),
    ("159952", "创业板ETF广发", "宽基/创业板", "chinext", "广发基金"),
    ("159977", "创业板ETF天弘", "宽基/创业板", "chinext", "天弘基金"),
    ("588080", "科创50ETF易方达", "宽基/科创50", "star50", "易方达"),
    ("588050", "科创50ETF工银", "宽基/科创50", "star50", "工银瑞信"),
    ("159901", "深证100ETF易方达", "宽基/深证100", "sz100", "易方达"),
    ("560050", "汇添富MSCI中国A50互联互通ETF", "宽基/MSCI中国A50", "hs300", "汇添富"),
    ("510100", "上证50ETF易方达", "宽基/上证50", "sse50", "易方达"),
    ("561580", "央企红利ETF华泰柏瑞", "宽基/央企红利", "cnsoe_div", "华泰柏瑞"),
    # —— 行业 / 主题 ——
    ("510230", "国泰上证180金融ETF", "行业/金融(180金融)", "fin180", "国泰基金"),
    ("512660", "国泰中证军工ETF", "行业/军工", "csimil", "国泰基金"),
    ("516110", "国泰中证800汽车与零部件ETF", "行业/汽车", "csiauto", "国泰基金"),
    ("159995", "芯片ETF华夏", "行业/芯片", "cnchip", "华夏基金"),
    ("515790", "华泰柏瑞中证光伏产业ETF", "行业/光伏", "csisolar", "华泰柏瑞"),
    ("512010", "易方达沪深300医药ETF", "行业/医药", "hs300med", "易方达"),
    ("512690", "鹏华中证酒ETF", "行业/酒", "csialcohol", "鹏华基金"),
    ("515170", "食品饮料ETF华夏", "行业/食品饮料", "csifood", "华夏基金"),
    ("159865", "国泰中证畜牧养殖ETF", "行业/畜牧", "csilivestock", "国泰基金"),
    ("512170", "医疗ETF华宝", "行业/医疗", "csimedical", "华宝基金"),
    ("159605", "中概互联ETF广发", "行业/中概互联30", "csichina30", "广发基金"),
    ("513050", "中概互联网ETF易方达", "行业/中概互联50", "csichina50", "易方达"),
    ("512400", "南方中证申万有色金属ETF", "行业/有色", "csinonferrous", "南方基金"),
    ("515210", "国泰中证钢铁ETF", "行业/钢铁", "csisteel", "国泰基金"),
    ("515020", "银行ETF华夏", "行业/银行", "cnbank", "华夏基金"),
    ("515050", "通信ETF华夏", "行业/通信", "cncomm", "华夏基金"),
    ("159562", "黄金股ETF", "行业/黄金股", "cngoldstock", "华夏基金"),
    ("159852", "软件ETF", "行业/软件", "cnsw", "华夏基金"),
    ("560170", "央企科技ETF南方", "行业/央企科技", "cnsoe_tech", "南方基金"),
]

INDEX_SECIDS = {
    "hs300": "1.000300",          # 沪深300
    "sse50": "1.000016",          # 上证50
    "sse180": "1.000010",         # 上证180
    "csi500": "1.000905",         # 中证500
    "csi800": "1.000906",         # 中证800
    "csi1000": "1.000852",        # 中证1000
    "chinext": "0.399006",        # 创业板指
    "star50": "1.000688",         # 科创50
    "sz100": "0.399330",          # 深证100
    # —— 行业/主题跟踪指数（各自 ETF 的 5th 图分母与基准线）——
    "fin180": "1.000018",         # 上证180金融
    "csifinre": "1.000934",       # 中证金融(地产)
    "csifintech": "2.930986",     # 中证金融科技
    "csimil": "0.399967",         # 中证军工
    "csiauto": "2.931008",        # 中证800汽车
    "cnchip": "0.980017",         # 国证半导体芯片
    "csisolar": "2.931151",       # 中证光伏产业
    "hs300med": "1.000913",       # 沪深300医药
    "csialcohol": "0.399987",     # 中证酒
    "csifood": "1.000815",        # 中证细分食品饮料
    "csilivestock": "2.930707",   # 中证畜牧养殖
    "csimedical": "0.399989",     # 中证医疗
    "csichina30": "2.930604",     # 中证海外中国互联网30
    "csichina50": "2.H30533",     # 中证海外中国互联网50
    "csinonferrous": "2.930708",  # 中证有色金属
    "csisteel": "2.930606",       # 中证钢铁
    "csichem": "1.000813",       # 中证细分化工
    "cnbank": "0.399986",        # 中证银行
    "cncomm": "2.931160",        # 中证全指通信设备
    "cnsoe_div": "1.000825",     # 中证央企红利
    "cnsoe_tech": "2.932038",    # 中证国新央企科技引领
    "cngoldstock": "2.931238",   # 中证沪深港黄金产业股票
    "cnsw": "2.930601",          # 中证软件服务
    # 注：MSCI中国A50互联互通无独立指数行情源，560050 回落到 hs300 作基准
}

# —— 顶层分类（界面两栏）：国家队宽基 = 汇金投资/汇金资管/国新/诚通 持有的宽基 ETF；其余行业/主题/货币 = 其他行业 ——
CATEGORY_BROAD = "国家队宽基ETF"
CATEGORY_SECTOR = "其他行业ETF"
CATEGORY_ORDER = [CATEGORY_BROAD, CATEGORY_SECTOR]


def category_of(group):
    return CATEGORY_BROAD if (group or "").startswith("宽基/") else CATEGORY_SECTOR


KLINE_BEG = "20240101"   # 日线起始
SHARE_BACKFILL_DEFAULT = 60  # 默认回补最近 N 个交易日的真实份额

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def http_get(url, referer=None, timeout=25, retries=3):
    """通过 curl 发起请求（Windows 10+ 自带 curl；规避 Python TLS 被远端拦截的问题）"""
    cmd = ["curl", "-s", "--max-time", str(timeout), "-A", UA]
    if referer:
        cmd += ["-H", f"Referer: {referer}"]
    cmd += [url]
    for attempt in range(retries):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=timeout + 10)
            if r.returncode == 0 and r.stdout:
                return r.stdout
            raise RuntimeError(f"curl exit={r.returncode} bytes={len(r.stdout)}")
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(1.2 * (attempt + 1))
    return b""


def secid_of(code):
    return ("1." if code[0] in "56" else "0.") + code


def tencent_symbol(secid):
    mkt, code = secid.split(".")
    return ("sh" if mkt == "1" else "sz") + code


def fetch_kline_sina(secid, beg=KLINE_BEG, is_etf=True):
    """新浪主源：返回 [(date, close, turnover_yuan_or_None)]。
    ETF：volume 单位为股，成交额 = 量×(O+H+L+C)/4 估算（对照东财真实值误差 <0.01%）。
    指数：新浪无成交额，返回 None（由东财补缺步骤填充）。
    注意：新浪日线为不复权价（宽基 ETF 极少分红，影响可忽略）。"""
    sym = tencent_symbol(secid)
    beg_date = f"{beg[:4]}-{beg[4:6]}-{beg[6:8]}"
    d0 = date(int(beg[:4]), int(beg[4:6]), int(beg[6:8]))
    need = min(1023, max(10, int((date.today() - d0).days * 0.75) + 10))
    url = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           f"CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen={need}")
    data = json.loads(http_get(url, referer="https://finance.sina.com.cn/").decode("utf-8"))
    out = []
    for r in data or []:
        d = r["day"]
        if d < beg_date:
            continue
        o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        amount = None
        if is_etf:
            amount = float(r["volume"]) * (o + h + l + c) / 4.0  # 股 × 均价 -> 元
        out.append((d, c, amount))
    if not out:
        raise RuntimeError("sina empty")
    return out


EM_HOSTS = ["push2delay.eastmoney.com", "push2his.eastmoney.com"]  # push2delay 当前可达，push2his 作备


def fetch_kline_eastmoney(secid, beg=KLINE_BEG):
    """东财：返回 [(date, close, turnover_yuan)]，成交额为真实值；多主机轮换抗限流"""
    last_err = None
    for host in EM_HOSTS:
        url = (f"https://{host}/api/qt/stock/kline/get?"
               f"secid={secid}&fields1=f1,f2,f3&fields2=f51,f53,f57&klt=101&fqt=1&beg={beg}&end=20500101")
        try:
            data = json.loads(http_get(url, retries=1).decode("utf-8"))
            klines = (data.get("data") or {}).get("klines") or []
            out = []
            for row in klines:
                parts = row.split(",")
                out.append((parts[0], float(parts[1]), float(parts[2])))
            if out:
                return out
            last_err = RuntimeError(f"{host} empty")
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError("eastmoney failed")


def fetch_kline_tencent(secid, beg=KLINE_BEG, is_etf=True):
    """腾讯备源：返回 [(date, close, turnover_yuan_or_None)]。
    ETF 成交额用 量(手)*100*均价 估算；指数无法直接估算成交额，返回 None 由调用方处理。"""
    sym = tencent_symbol(secid)
    beg_fmt = f"{beg[:4]}-{beg[4:6]}-{beg[6:8]}"
    fq = "qfq" if is_etf else ""
    url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
           f"param={sym},day,{beg_fmt},2050-01-01,640,{fq}")
    data = json.loads(http_get(url, referer="https://gu.qq.com/").decode("utf-8"))
    node = (data.get("data") or {}).get(sym) or {}
    rows = node.get("qfqday") or node.get("day") or []
    out = []
    for r in rows:
        d, o, c, h, l, vol = r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])
        amount = None
        if is_etf:
            avg = (o + c + h + l) / 4.0
            amount = vol * 100.0 * avg  # 手 -> 股，估算成交额(元)
        out.append((d, c, amount))
    if not out:
        raise RuntimeError("tencent empty")
    return out


# ===================== 通达信兜底备源（纯标准库 socket 协议，零依赖） =====================
# 场景：GitHub Actions 等境外 IP 下，新浪/东财/腾讯常被墙；通达信行情服务器（电信/联通
# 节点）在境外多可达，提供 SH/SZ 指数与全部 ETF 的真实收盘价 + 真实成交额（不复权）。
# 协议要点：3 个握手包 → 请求包(struct)；响应 16 字节头含 zip/unzip 长度，zip!=unzip 时
# zlib 解压；日线体为 差分 varint 价格 + 浮点编码量额；指数比个股多 4 字节涨跌家数。

TDX_SERVERS = [
    ("60.12.136.250", 7709), ("218.108.98.244", 7709), ("115.238.90.165", 7709),
    ("218.75.126.9", 7709), ("124.71.187.122", 7709), ("218.6.170.47", 7709),
    ("119.147.212.81", 7709), ("123.125.108.14", 7709),
]
TDX_SETUP = [
    bytes.fromhex("0c 02 18 93 00 01 03 00 03 00 0d 00 01"),
    bytes.fromhex("0c 02 18 94 00 01 03 00 03 00 0d 00 02"),
    bytes.fromhex("0c 03 18 99 00 01 20 00 20 00 db 0f d5 d0 c9 cc d6 a4 a8 af "
                  "00 00 00 8f c2 25 40 13 00 00 d5 00 c9 cc bd f0 d7 ea 00 00 00 02"),
]
_TDX = {"sock": None, "dead": False}  # 复用长连接；dead=True 表示本轮所有服务器不可达，后续直接跳过


def _tdx_build_req(market, code, start, count):
    code_b = code.encode("utf-8") if isinstance(code, str) else code
    values = (0x10c, 0x01016408, 0x1c, 0x1c, 0x052d, market, code_b,
              9, 1, start, count, 0, 0, 0)  # category=9 日线
    return struct.pack("<HIHHHH6sHHHHIIH", *values)


def _tdx_recv(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def _tdx_call(sock, pkg):
    sock.sendall(pkg)
    head = _tdx_recv(sock, 16)
    if len(head) < 16:
        raise RuntimeError("tdx head short")
    _, _, _, zipsize, unzipsize = struct.unpack("<IIIHH", head)
    body = _tdx_recv(sock, zipsize)
    if len(body) < zipsize:
        raise RuntimeError("tdx body short")
    if zipsize != unzipsize:
        body = zlib.decompress(body)
    return body


def _tdx_price(data, pos):
    """通达信有符号变长整数（base128 varint，最低字节高位=符号）"""
    pos_byte = 6
    b = data[pos]
    intdata = b & 0x3f
    sign = bool(b & 0x40)
    if b & 0x80:
        while True:
            pos += 1
            b = data[pos]
            intdata += (b & 0x7f) << pos_byte
            pos_byte += 7
            if not (b & 0x80):
                break
    pos += 1
    if sign:
        intdata = -intdata
    return intdata, pos


def _tdx_volume(ivol):
    """通达信量/额浮点编码解码（源自 pytdx，逐位复刻）"""
    logpoint = ivol >> 24
    hleax = (ivol >> 16) & 0xff
    lheax = (ivol >> 8) & 0xff
    lleax = ivol & 0xff
    dwEcx = logpoint * 2 - 0x7f
    dwEdx = logpoint * 2 - 0x86
    dwEsi = logpoint * 2 - 0x8e
    dwEax = logpoint * 2 - 0x96
    tmpEax = -dwEcx if dwEcx < 0 else dwEcx
    dbl_xmm6 = pow(2.0, tmpEax)
    if dwEcx < 0:
        dbl_xmm6 = 1.0 / dbl_xmm6
    if hleax > 0x80:
        tmpdbl_xmm3 = pow(2.0, dwEdx + 1)
        dbl_xmm0 = pow(2.0, dwEdx) * 128.0 + (hleax & 0x7f) * tmpdbl_xmm3
        dbl_xmm4 = dbl_xmm0
    else:
        if dwEdx >= 0:
            dbl_xmm4 = pow(2.0, dwEdx) * hleax
        else:
            dbl_xmm4 = (1 / pow(2.0, dwEdx)) * hleax
    dbl_xmm3 = pow(2.0, dwEsi) * lheax
    dbl_xmm1 = pow(2.0, dwEax) * lleax
    if hleax & 0x80:
        dbl_xmm3 *= 2.0
        dbl_xmm1 *= 2.0
    return dbl_xmm6 + dbl_xmm4 + dbl_xmm3 + dbl_xmm1


def _tdx_parse(buf, is_index):
    (n,) = struct.unpack("<H", buf[0:2])
    pos = 2
    out = []
    pre_diff_base = 0
    for _ in range(n):
        (zipday,) = struct.unpack("<I", buf[pos:pos + 4]); pos += 4  # 日线 category>=4：YYYYMMDD 整数
        year = zipday // 10000
        month = (zipday % 10000) // 100
        day = zipday % 100
        po, pos = _tdx_price(buf, pos)   # open diff
        pc, pos = _tdx_price(buf, pos)   # close diff
        _ph, pos = _tdx_price(buf, pos)  # high diff（未用）
        _pl, pos = _tdx_price(buf, pos)  # low diff（未用）
        pos += 4                          # vol_raw（未用）
        (amt_raw,) = struct.unpack("<I", buf[pos:pos + 4]); pos += 4
        if is_index:
            pos += 4                      # up_count, down_count
        base = po + pre_diff_base
        close = (base + pc) / 1000.0
        pre_diff_base = base + pc
        amount = _tdx_volume(amt_raw)
        out.append((year, month, day, close, amount))
    return out


def _tdx_sock():
    """返回可用长连接（缓存复用）；不可用时轮换服务器重连并握手。
    若本轮已判定所有服务器不可达（dead），立即抛错，避免每个标的重复 8×超时。"""
    if _TDX.get("dead"):
        raise RuntimeError("tdx dead(本轮已判定不可达)")
    s = _TDX.get("sock")
    if s is not None:
        return s
    last_err = None
    for ip, port in TDX_SERVERS:
        try:
            s = socket.create_connection((ip, port), timeout=4)
            s.settimeout(8)
            for p in TDX_SETUP:
                _tdx_call(s, p)
            _TDX["sock"] = s
            return s
        except Exception as e:
            last_err = e
            continue
    _TDX["dead"] = True  # 8 台全挂 → 境外多半整体被墙，本轮不再尝试
    raise RuntimeError("tdx no server: %s" % last_err)


def _tdx_close():
    s = _TDX.get("sock")
    if s is not None:
        try:
            s.close()
        except Exception:
            pass
        _TDX["sock"] = None


def fetch_kline_tdx(secid, beg=KLINE_BEG, is_etf=True):
    """通达信兜底：返回 [(date, close, turnover_yuan)]，收盘价与成交额均为真实值（不复权）。
    仅支持 SH(1.)/SZ(0.) 的指数与 ETF；中证 2.xxx、国证 980xxx 指数库不含，直接抛错回退。"""
    mkt_prefix, code = secid.split(".")
    if mkt_prefix == "2":
        raise RuntimeError("tdx 不支持中证指数(2.xxx)")
    if (not is_etf) and code.startswith("980"):
        raise RuntimeError("tdx 不支持国证指数(980xxx)")
    market = 1 if mkt_prefix == "1" else 0
    is_index = not is_etf
    # 一个页(800)覆盖约 3.2 年，足够 KLINE_BEG=2024 起；带一次断线重连
    for attempt in range(2):
        try:
            s = _tdx_sock()
            body = _tdx_call(s, _tdx_build_req(market, code, 0, 800))
            bars = _tdx_parse(body, is_index)
            break
        except Exception:
            _tdx_close()
            if attempt == 1:
                raise
    beg_date = f"{beg[:4]}-{beg[4:6]}-{beg[6:8]}"
    out = []
    for (y, mo, d, close, amount) in bars:
        ds = f"{y:04d}-{mo:02d}-{d:02d}"
        if ds < beg_date or close <= 0:
            continue
        amt = amount if amount and amount > 0 else None
        out.append((ds, close, amt))
    if not out:
        raise RuntimeError("tdx empty")
    return out


# ==========================================================================================

_FAILS = {"sina": 0, "em": 0, "sohu": 0, "tencent": 0}  # 各源连续失败次数；连续失败 2 次后本轮跳过该源


def fetch_kline(secid, beg=KLINE_BEG, is_etf=True):
    """多源容错，优先级：新浪 → 东财 → 腾讯 → 通达信（连续失败的源在本轮自动跳过）"""
    if _FAILS["sina"] < 2:
        try:
            out = fetch_kline_sina(secid, beg, is_etf)
            _FAILS["sina"] = 0
            return out
        except Exception as e:
            _FAILS["sina"] += 1
            print(f"  ! 新浪源失败({secid}): {str(e)[:60]}，切换东财备源")
    if _FAILS["em"] < 2:
        try:
            out = fetch_kline_eastmoney(secid, beg)
            _FAILS["em"] = 0
            return out
        except Exception as e:
            _FAILS["em"] += 1
            print(f"  ! 东财源失败({secid}): {str(e)[:60]}，切换腾讯备源")
    if _FAILS["tencent"] < 2:
        try:
            out = fetch_kline_tencent(secid, beg, is_etf)
            _FAILS["tencent"] = 0
            return out
        except Exception as e:
            _FAILS["tencent"] += 1
            print(f"  ! 腾讯源失败({secid}): {str(e)[:60]}，切换通达信兜底")
    out = fetch_kline_tdx(secid, beg, is_etf)
    return out


def merge_kline(cache_rows, fresh_rows):
    """按日期合并：新数据覆盖旧数据；成交额为 None 时保留旧值"""
    merged = {d: [c, t] for (d, c, t) in cache_rows}
    for (d, c, t) in fresh_rows:
        old = merged.get(d)
        if t is None and old is not None and old[1] is not None:
            t = old[1]
        merged[d] = [c, t]
    return [(d, v[0], v[1]) for d, v in sorted(merged.items())]


def load_kline_cached(cache, key, secid, is_etf=True):
    """增量抓取：只从缓存最后日期开始拉，与缓存合并后回写。
    ETF 缓存若存在成交额缺失（此前走无额备源），则全量重拉补齐。"""
    old = [tuple(r) for r in cache.get(key, [])]
    has_gap = is_etf and any(r[2] is None for r in old)
    beg = KLINE_BEG
    if old and not has_gap:
        beg = old[-1][0].replace("-", "")  # 从最后一天重拉（覆盖当日未收盘数据）
    fresh = fetch_kline(secid, beg, is_etf)
    merged = merge_kline(old, fresh)
    cache[key] = [list(r) for r in merged]
    return merged


def fetch_index_turnover_sohu(secid, beg=KLINE_BEG):
    """搜狐历史行情：指数真实成交金额。返回 {date: turnover_yuan}。
    接口返回 GBK 编码 jsonp；成交金额列单位为万元。"""
    code = "zs_" + secid.split(".")[1]
    end = date.today().strftime("%Y%m%d")
    url = (f"https://q.stock.sohu.com/hisHq?code={code}&start={beg}&end={end}"
           "&stat=1&order=D&period=d&rt=jsonp")
    raw = http_get(url, referer="https://q.stock.sohu.com/").decode("gbk", errors="replace")
    m = re.search(r"\((.*)\)", raw, re.S)
    if not m:
        raise RuntimeError("sohu bad response")
    data = json.loads(m.group(1))
    hq = (data[0] or {}).get("hq") or []
    out = {}
    for r in hq:
        try:
            out[r[0]] = float(r[8]) * 1e4  # 万元 -> 元
        except (TypeError, ValueError, IndexError):
            pass
    if not out:
        raise RuntimeError("sohu empty")
    return out


def fill_index_turnover(cache, key, secid):
    """指数成交额补缺：新浪指数线无成交额，优先搜狐（真实值），失败退东财"""
    rows = [tuple(r) for r in cache.get(key, [])]
    missing = [d for (d, _c, t) in rows if t is None]
    if not missing:
        return rows
    tmap = None
    if _FAILS["sohu"] < 2:
        try:
            tmap = fetch_index_turnover_sohu(secid, missing[0].replace("-", ""))
            _FAILS["sohu"] = 0
        except Exception as e:
            _FAILS["sohu"] += 1
            print(f"  ! 搜狐指数成交额失败({secid}): {str(e)[:50]}，尝试东财")
    if tmap is None and _FAILS["em"] < 2:
        try:
            fresh = fetch_kline_eastmoney(secid, missing[0].replace("-", ""))
            tmap = {d: t for (d, _c, t) in fresh}
            _FAILS["em"] = 0
        except Exception as e:
            _FAILS["em"] += 1
            print(f"  ! 指数成交额补缺失败({secid}): {str(e)[:50]}（收盘价不受影响，下轮自动重试）")
    if tmap is None:
        return rows
    merged = [(d, c, tmap.get(d, t) if t is None else t) for (d, c, t) in rows]
    cache[key] = [list(r) for r in merged]
    return merged


# ---------------- 份额抓取 ----------------

def fetch_sse_shares(stat_date):
    """沪市：返回 {code: 份额(亿份)}，一次请求覆盖全部沪市 ETF"""
    url = ("http://query.sse.com.cn/commonQuery.do?"
           "sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L"
           f"&STAT_DATE={stat_date}&pageHelp.pageSize=9000&isPagination=false")
    data = json.loads(http_get(url, referer="http://www.sse.com.cn/").decode("utf-8"))
    rows = data.get("result") or []
    out = {}
    for r in rows:
        code = r.get("SEC_CODE", "")
        vol = r.get("TOT_VOL", "")
        try:
            out[code] = round(float(str(vol).replace(",", "")) / 10000.0, 4)  # 万份 -> 亿份
        except (TypeError, ValueError):
            pass
    return out


def _xlsx_rows(content):
    """纯标准库解析 xlsx 第一个工作表，返回 [[cell,...],...]（全部转成字符串）"""
    zf = zipfile.ZipFile(io.BytesIO(content))
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        ns = {"m": root.tag.split("}")[0].strip("{")}
        for si in root.findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t")))
    sheet_name = next((n for n in zf.namelist() if re.match(r"xl/worksheets/sheet1\.xml$", n)), None)
    if not sheet_name:
        return []
    root = ET.fromstring(zf.read(sheet_name))
    ns = {"m": root.tag.split("}")[0].strip("{")}
    rows = []
    for row in root.findall(".//m:row", ns):
        cells = []
        for c in row.findall("m:c", ns):
            v = c.find("m:v", ns)
            txt = ""
            if v is not None and v.text is not None:
                if c.get("t") == "s":
                    idx = int(v.text)
                    txt = shared[idx] if idx < len(shared) else ""
                else:
                    txt = v.text
            else:
                is_node = c.find("m:is", ns)
                if is_node is not None:
                    txt = "".join(t.text or "" for t in is_node.iter() if t.tag.endswith("}t"))
            cells.append(txt)
        rows.append(cells)
    return rows


def fetch_szse_hist_range(codes, start, end):
    """深市：fund_jjgm 历史规模，返回 {date: {code: 份额(亿份)}}。
    current_size 单位为万份 -> /1e4 转亿份。该接口支持全量历史数据查询，
    但单次查询跨度不宜过大（经验值 <~1 年返回条数多需多页翻页），
    内部按 ~90 天分段查询+翻页，覆盖 [start, end] 全区间。"""
    out = {}
    referer = "https://investor.szse.cn/fund/marketdata/etf/index.html"
    # 分段：按 ~90 天切分 [start, end]
    seg_start = datetime.strptime(start, "%Y-%m-%d").date()
    seg_end = datetime.strptime(end, "%Y-%m-%d").date()
    segments = []
    cur = seg_start
    while cur <= seg_end:
        nxt = min(cur + timedelta(days=89), seg_end)
        segments.append((cur.strftime("%Y-%m-%d"), nxt.strftime("%Y-%m-%d")))
        cur = nxt + timedelta(days=1)
    for code in codes:
        for seg_s, seg_e in segments:
            pageno = 1
            while True:
                url = ("https://investor.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON"
                       f"&CATALOGID=fund_jjgm&TABKEY=tab1&txtDm={code}"
                       f"&txtStart={seg_s}&txtEnd={seg_e}&PAGENO={pageno}&pageSize=1000&random=0.4")
                raw = http_get(url, referer=referer)
                if not raw:
                    break
                try:
                    j = json.loads(raw.decode("utf-8", "replace"))
                    tab = j[0]
                    data = tab.get("data") or []
                    meta = tab.get("metadata") or {}
                except Exception:
                    break
                for row in data:
                    d = (row.get("size_date") or "").strip()
                    cs = row.get("current_size")
                    if d and cs:
                        try:
                            out.setdefault(d, {})[code] = round(float(str(cs).replace(",", "")) / 10000.0, 4)
                        except (TypeError, ValueError):
                            pass
                pc = int(meta.get("pagecount") or 1)
                if pageno >= pc or not data:
                    break
                pageno += 1
            time.sleep(0.2)
        time.sleep(0.3)
    return out


# ---------------- 主流程 ----------------

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", type=int, default=SHARE_BACKFILL_DEFAULT,
                    help="回补最近 N 个交易日的真实份额（默认 %(default)s）")
    args = ap.parse_args()

    kline_cache_path = os.path.join(BASE, "kline_cache.json")
    kline_cache = load_json(kline_cache_path, {})

    print("[1/5] 拉取指数日线（收盘价：新浪主源；成交额：东财补缺）...")
    index_kline = {}
    for key, secid in INDEX_SECIDS.items():
        # 每个指数独立重置三源失败计数：各指数相互独立，且 930xxx 行业指数新浪/搜狐本就无覆盖，
        # 若不顺带重置 sina/sohu，连续几个行业指数会把其失败计数打满，误伤后续宽基指数的新浪主源。
        # 东财恢复后重跑即自动补齐行业指数。
        _FAILS["sina"] = _FAILS["em"] = _FAILS["sohu"] = 0
        try:
            load_kline_cached(kline_cache, "idx_" + key, secid, is_etf=False)
            index_kline[key] = fill_index_turnover(kline_cache, "idx_" + key, secid)
            n_amt = sum(1 for r in index_kline[key] if r[2] is not None)
            print(f"  {key}: {len(index_kline[key])} 天（成交额 {n_amt} 天）")
        except Exception as e:
            # 关键：抓取失败时回退到已缓存数据，而不是置空丢弃。
            # 否则东财等源临时故障会把此前已缓存的行业指数(如金融科技/汽车)在输出中抹成空缺。
            cached = [tuple(r) for r in kline_cache.get("idx_" + key, [])]
            if cached:
                print(f"  ! 指数 {key}({secid}) 本轮抓取失败({str(e)[:40]})，沿用缓存 {len(cached)} 天")
                index_kline[key] = cached
            else:
                print(f"  ! 指数 {key}({secid}) 行情获取失败且无缓存: {str(e)[:40]}，该基准线/成交额将空缺")
                index_kline[key] = []
        time.sleep(0.4)
    save_json(kline_cache_path, kline_cache)

    # 指数抓取可能把 sina 失败计数打满（部分行业指数新浪无覆盖），
    # 但 ETF 抓取新浪稳定可用，故重置失败计数，避免误伤 ETF 主源
    _FAILS["sina"] = _FAILS["em"] = _FAILS["sohu"] = 0

    print("[2/5] 拉取 ETF 日线（前复权价 + 成交额，增量）...")
    etf_kline = {}
    for (code, name, *_r) in ETFS:
        try:
            etf_kline[code] = load_kline_cached(kline_cache, "etf_" + code, secid_of(code), is_etf=True)
            print(f"  {code} {name}: {len(etf_kline[code])} 天")
        except Exception as e:
            # 单只 ETF 抓取失败不应拖垮全部 40 只：回退缓存，无缓存才置空并继续
            cached = [tuple(r) for r in kline_cache.get("etf_" + code, [])]
            etf_kline[code] = cached
            print(f"  ! {code} {name} 本轮抓取失败({str(e)[:40]})，沿用缓存 {len(cached)} 天" if cached else f"  ! {code} {name} 抓取失败且无缓存: {str(e)[:40]}")
        time.sleep(0.25)
    save_json(kline_cache_path, kline_cache)

    # 交易日全集（优先沪深300；若缺失则取任一非空指数）
    trade_dates = [d for (d, _c, _t) in index_kline["hs300"]] if index_kline.get("hs300") else []
    if not trade_dates:
        for _k, _kl in index_kline.items():
            if _kl:
                trade_dates = [d for (d, _c, _t) in _kl]
                break
    if not trade_dates:
        raise RuntimeError("无可用指数日线，无法构建交易日序列")

    print(f"[3/5] 抓取真实份额（沪：按日；深：fund_jjgm 历史区间；目标窗口=最近 {args.backfill} 个交易日）...")
    cache_path = os.path.join(BASE, "shares_cache.json")
    cache = load_json(cache_path, {})  # {date: {code: shares_yi}}
    target_dates = trade_dates[-args.backfill:]
    # 货币ETF(如511860)无交易所日频份额数据(SSE/SZSE接口均不返回)，排除出抓取与"缺失"判定，
    # 否则它永远是 None，会把每个目标日期都误判为"缺沪市份额"，导致每轮冗余重抓全部窗口。
    share_eligible = {c for (c, _n, grp, *_r) in ETFS if grp != "货币"}
    szse_codes = {c for c in share_eligible if c[0] not in "56"}
    sse_codes = share_eligible - szse_codes

    # 深市份额权威源 = fund_jjgm 历史接口，支持全量历史日频数据（分段查询+翻页）。
    # 关键：抓取窗口覆盖全部交易日（trade_dates[0] ~ trade_dates[-1]），而非仅近期。
    # fund_jjgm 内部按 ~90 天分段查询，每段翻页获取全部记录。
    szse_start = trade_dates[0]
    szse_end = trade_dates[-1]
    szse_hist = fetch_szse_hist_range(sorted(szse_codes), szse_start, szse_end)
    # 深市值仅以 fund_jjgm 命中窗口为准：先清掉所有缓存日期里的深市代码（含旧版 xlsx 常数残留），
    # 再用权威窗口整体重建。窗口外（更早日期）本就无公开日频数据，置空(null)而非伪造常数。
    for d in list(cache):
        day = cache.get(d)
        if day:
            for c in szse_codes:
                day.pop(c, None)
    for d, cmap in szse_hist.items():
        cache.setdefault(d, {}).update(cmap)
    szse_cov = sum(1 for d in trade_dates if any(c in (cache.get(d) or {}) for c in szse_codes))
    print(f"  深市 fund_jjgm 窗口 {szse_start} ~ {szse_end}，覆盖 {szse_cov} 个交易日")

    # 沪市抓取按"代码是否缺失"判定，而非"该日期是否已在 cache 中"——
    # 否则深市 fund_jjgm 已填入的近期窗口日期会被跳过，导致沪市 ETF 在最新窗口出现空缺。
    def sse_missing_dates():
        out = []
        for d in target_dates:
            day = cache.get(d, {})
            if any(day.get(c) is None for c in sse_codes):
                out.append(d)
        return out
    missing = sse_missing_dates()
    print(f"  沪市待补 {len(missing)} 天（含已含深市值但仍缺沪市值的日期）")
    for i, d in enumerate(missing):
        day = {}
        try:
            sse = fetch_sse_shares(d)  # 沪市：一次请求覆盖全部沪市 ETF
            for c in sse_codes:
                v = sse.get(c)
                if v:
                    day[c] = v
        except Exception as e:
            print(f"  ! {d} 沪市抓取失败: {e}")
        if day:
            existing = cache.get(d, {})
            existing.update(day)  # 保留已合并的深市真实值，不覆盖
            cache[d] = existing
        if (i + 1) % 10 == 0 or i == len(missing) - 1:
            save_json(cache_path, cache)
            print(f"  进度 {i + 1}/{len(missing)}（{d}）")
        time.sleep(0.35)
    save_json(cache_path, cache)

    print("[4/5] 合并披露数据（disclosures.json）...")
    disclosures_cfg = load_json(os.path.join(BASE, "disclosures.json"), {})

    print("[5/5] 组装 APP_DATA 并写出 data.js / data.json ...")
    refreshed_at = datetime.now().astimezone().isoformat(timespec="seconds")
    etfs_data, universe = {}, []
    index_close_map = {k: {d: c for (d, c, _t) in v} for k, v in index_kline.items()}

    for (code, name, group, idx_key, manager) in ETFS:
        kl = etf_kline[code]
        dates = [d for (d, _c, _t) in kl]
        # 份额序列：真实数据优先；真实窗口内缺失日期沿用最近已知值（份额为存量，前向填充合理）；
        # 首个真实数据日之前一律为 None（输出 null，前端显示空缺而非虚假的 0）
        share_series, last_share = [], None
        known = {d: cache.get(d, {}).get(code) for d in dates}
        for d in dates:
            v = known.get(d)
            if v:
                last_share = v
            share_series.append(last_share)  # 首个真实值之前保持 None
        has_share = last_share is not None

        series = []
        prev_share = None
        prev_turn = 0.0
        for i, (d, close, turn_yuan) in enumerate(kl):
            sh = share_series[i]
            flow = None
            if sh is not None and prev_share is not None:
                flow = round(sh - prev_share, 4)
            prev_share = sh if sh is not None else prev_share
            if turn_yuan is None:
                turn_yuan = prev_turn
            prev_turn = turn_yuan
            series.append({
                "date": d,
                "etf_qfq_close": close,
                "etf_qfq_turnover_est_yi": round(turn_yuan / 1e8, 4),
                "qfq_total_units_yi": sh,
                "qfq_delta_units_yi": flow,
                "flow_amount_yi": round(flow * close, 4) if flow is not None else None,
                "benchmark_close": index_close_map.get(idx_key, {}).get(d) if idx_key else None,
            })

        dlist = disclosures_cfg.get(code, [])
        latest = dlist[-1] if dlist else {}
        meta = {
            "code": code,
            "name": name,
            "display_group": group,
            "category": category_of(group),
            "manager": manager,
            "dashboard_eligible": True,
            "latest_report_date": latest.get("report_date", ""),
            "latest_combined_ratio_pct": latest.get("combined_ratio_pct"),
            "latest_combined_value_yi": latest.get("combined_value_yi"),
            "holder_rows": sum(x.get("holder_rows", 1) for x in dlist),
            "data_refreshed_at": refreshed_at,
            "latest_series_date": dates[-1] if dates else "",
            "share_data_real": has_share,
        }
        etfs_data[code] = {"meta": meta, "series": series, "disclosures": dlist}
        universe.append(meta)

    groups, seen = [], set()
    for (_c, _n, group, *_r) in ETFS:
        if group not in seen:
            seen.add(group)
            groups.append({"group": group})

    categories = [{"key": c} for c in CATEGORY_ORDER]

    # 只保留参考交易日(沪深300, 来自新浪)内的完整交易日，剔除东财可能多出的"今日未收盘"partial行，
    # 保证所有指数与 ETF 主序列在同一完整日历上对齐（前端按 ETF 日期 join，partial 行无对应数据）。
    trade_set = set(trade_dates)
    index_turnover = {}
    for key, kl in index_kline.items():
        rows, prev_t = [], 0.0
        for (d, _c, t) in kl:
            if d not in trade_set:
                continue
            if t is None:
                t = prev_t
            prev_t = t
            rows.append({"date": d, "turnover_yi": round(t / 1e8, 2)})
        index_turnover[key] = {"meta": {"index_key": key}, "rows": rows}

    app_data = {
        "universe": universe,
        "groups": groups,
        "categories": categories,
        "etfs": etfs_data,
        "indexTurnover": index_turnover,
        "site_name": "汇金证金及其关联公司持仓追踪",
        "refreshed_at": refreshed_at,
    }

    with open(os.path.join(BASE, "data.json"), "w", encoding="utf-8") as f:
        json.dump(app_data, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(BASE, "data.js"), "w", encoding="utf-8") as f:
        f.write("window.APP_DATA = ")
        json.dump(app_data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    print(f"完成：{len(etfs_data)} 只 ETF，{len(trade_dates)} 个交易日，刷新时间 {refreshed_at}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
