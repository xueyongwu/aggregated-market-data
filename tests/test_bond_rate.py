"""bond_rate 选券逻辑自检(离线, 合成 records)。跑: python -m tests.test_bond_rate"""
from pipeline.stock.bond_rate import is_treasury, pick, years


def rec(name, term, vol, rate="1.70", code="000000", bp=-0.5):
    return {"abdAssetEncdShrtDesc": name, "bondcode": code, "termToMaturity": term,
            "dmiTtlTradedAmnt": vol, "dmiLatestContraRate": rate, "bpNum": bp,
            "showDate": "2026-07-31 17:35:08"}


def test_years():
    assert years("9.79Y") == 9.79
    assert round(years("172D"), 4) == round(172 / 365, 4)


def test_is_treasury():
    assert is_treasury("26附息国债10")
    assert is_treasury("26超长特别国债04")
    assert not is_treasury("26贴现国债45")   # 零息短债
    assert not is_treasury("26国开05")       # 政金债不是国债
    assert not is_treasury("26中国银行CD053")


def test_pick_max_volume():
    # 桶内取成交量最大的那只, 不是列表里第一只
    rs = [rec("25附息国债16", "9.07Y", "18.6"), rec("26附息国债10", "9.79Y", "612.8", rate="1.7045"),
          rec("26附息国债05", "9.57Y", "126.0")]
    assert pick(rs, 9.0, 10.5)["name"] == "26附息国债10"
    assert pick(rs, 9.0, 10.5)["yield"] == 1.7045


def test_pick_excludes_non_treasury_and_out_of_bucket():
    # 国开债量最大但不是国债; 7 年国债在桶外 -> 都不选
    rs = [rec("26国开05", "9.60Y", "2071.4"), rec("26附息国债07", "6.65Y", "999.9"),
          rec("26附息国债10", "9.79Y", "612.8")]
    assert pick(rs, 9.0, 10.5)["name"] == "26附息国债10"


def test_pick_skips_blank_rate():
    # 只有净价没有收益率的行不能选(float("") 会炸)
    rs = [rec("26附息国债09", "9.5Y", "900", rate=""), rec("26附息国债10", "9.79Y", "612.8")]
    assert pick(rs, 9.0, 10.5)["name"] == "26附息国债10"


def test_empty_bucket_raises():
    try:
        pick([rec("26附息国债07", "6.65Y", "10")], 28.0, 30.5)
    except RuntimeError:
        return
    raise AssertionError("桶内无券时应抛 RuntimeError")


def test_absurd_yield_raises():
    try:
        pick([rec("26附息国债10", "9.79Y", "612.8", rate="170.45")], 9.0, 10.5)
    except RuntimeError:
        return
    raise AssertionError("收益率出格时应抛 RuntimeError")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
