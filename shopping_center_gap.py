#!/usr/bin/env python3
"""
Shopping Center Gap Analysis Tool
==================================
1. Discovers all tenants at a given shopping center via Google Places API.
2. Maps each tenant to a SIC code.
3. Compares current tenant mix against a benchmark neighborhood-center mix
   to find the 15 biggest category gaps.
4. Searches a wider radius for 20 likely relocation candidates for those
   missing categories, excluding any businesses already within 5 miles.
5. Exports results to Excel (or CSV fallback) and prints a clean summary.

Usage:
    python shopping_center_gap.py --key YOUR_API_KEY --lat 33.6583 --lng -117.8667
    python shopping_center_gap.py --config config.json
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import googlemaps
import pandas as pd
from geopy.distance import geodesic

# ── Try optional pretty-print deps ──────────────────────────────────────────
try:
    from tabulate import tabulate
    HAS_TABULATE = True
except ImportError:
    HAS_TABULATE = False

try:
    import openpyxl  # noqa: F401 — just checking availability
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False


# ════════════════════════════════════════════════════════════════════════════
# SIC CODE MAPPINGS
# ════════════════════════════════════════════════════════════════════════════

# Google Places type → SIC code  (ordered: more-specific first)
GOOGLE_TYPE_TO_SIC: dict[str, str] = {
    # ── Food & Beverage ──────────────────────────────────────────────────
    "bakery":                   "5461",
    "bar":                      "5813",
    "night_club":               "5813",
    "liquor_store":             "5921",
    "grocery_or_supermarket":   "5411",
    "supermarket":              "5411",
    "convenience_store":        "5411",
    "food":                     "5411",
    "restaurant":               "5812",
    "cafe":                     "5812",
    "meal_takeaway":            "5812",
    "meal_delivery":            "5812",
    # ── Health & Personal Care ───────────────────────────────────────────
    "pharmacy":                 "5912",
    "drugstore":                "5912",
    "doctor":                   "8011",
    "physiotherapist":          "8049",
    "dentist":                  "8021",
    "hospital":                 "8062",
    "veterinary_care":          "0742",
    "hair_care":                "7231",
    "beauty_salon":             "7231",
    "nail_salon":               "7231",
    "spa":                      "7299",
    # ── Fitness & Recreation ─────────────────────────────────────────────
    "gym":                      "7991",
    # ── Retail ───────────────────────────────────────────────────────────
    "department_store":         "5311",
    "clothing_store":           "5651",
    "shoe_store":               "5661",
    "jewelry_store":            "5944",
    "furniture_store":          "5712",
    "home_goods_store":         "5719",
    "electronics_store":        "5731",
    "hardware_store":           "5251",
    "pet_store":                "5999",
    "florist":                  "5992",
    "book_store":               "5942",
    "toy_store":                "5945",
    "sporting_goods_store":     "5941",
    "bicycle_store":            "5941",
    "mobile_phone":             "5731",
    "auto_parts_store":         "5531",
    "car_dealer":               "5511",
    # ── Services ─────────────────────────────────────────────────────────
    "laundry":                  "7211",
    "dry_cleaning":             "7212",
    "car_wash":                 "7542",
    "car_repair":               "7538",
    "gas_station":              "5541",
    "parking":                  "7521",
    # ── Professional & Financial ─────────────────────────────────────────
    "bank":                     "6021",
    "atm":                      "6099",
    "insurance_agency":         "6411",
    "real_estate_agency":       "6531",
    "lawyer":                   "8111",
    "accounting":               "8721",
    "travel_agency":            "4724",
    "post_office":              "4311",
    # ── Education & Childcare ────────────────────────────────────────────
    "school":                   "8299",
    "university":               "8221",
    "library":                  "8231",
    "child_care":               "8351",
    # ── Other ─────────────────────────────────────────────────────────────
    "movie_theater":            "7832",
    "amusement_park":           "7996",
    "museum":                   "8412",
    "lodging":                  "7011",
    "tax_preparation":          "7291",
    "print_shop":               "7334",
    "copy_center":              "7334",
}

SIC_LABELS: dict[str, str] = {
    "0742": "Veterinary Services",
    "4311": "Post Office",
    "4724": "Travel Agency",
    "5251": "Hardware Store",
    "5311": "Department Store",
    "5411": "Grocery / Specialty Food",
    "5461": "Bakery",
    "5511": "Auto Dealer",
    "5531": "Auto Parts",
    "5541": "Gas Station",
    "5651": "Clothing / Apparel",
    "5661": "Shoe Store",
    "5712": "Furniture Store",
    "5719": "Home Goods",
    "5731": "Electronics / Phone Repair",
    "5812": "Eating Places / Restaurant",
    "5813": "Bar / Tavern",
    "5912": "Pharmacy / Drug Store",
    "5921": "Liquor Store",
    "5941": "Sporting Goods",
    "5942": "Book Store",
    "5944": "Jewelry Store",
    "5945": "Toy / Hobby Store",
    "5992": "Florist",
    "5999": "Pet Store / Supplies",
    "6021": "Bank",
    "6099": "ATM / Financial Services",
    "6411": "Insurance Agency",
    "6531": "Real Estate Agency",
    "7011": "Hotel / Motel",
    "7211": "Laundry / Dry Cleaning",
    "7212": "Dry Cleaning",
    "7231": "Hair / Nail / Beauty Salon",
    "7291": "Tax Preparation",
    "7299": "Spa / Personal Services",
    "7334": "Print / Copy Center",
    "7521": "Parking",
    "7538": "Auto Repair",
    "7542": "Car Wash",
    "7832": "Movie Theater",
    "7991": "Fitness / Gym",
    "7996": "Amusement / Recreation",
    "8011": "Medical / Urgent Care",
    "8021": "Dentist",
    "8049": "Physical Therapist",
    "8062": "Hospital",
    "8111": "Law Office",
    "8221": "College / University",
    "8231": "Library",
    "8299": "Educational / Tutoring",
    "8351": "Child Care / Daycare",
    "8412": "Museum",
    "8721": "Accounting / Tax Services",
    "9999": "Unknown",
}


# ════════════════════════════════════════════════════════════════════════════
# BENCHMARK TENANT MIX
# Ideal number of tenants per SIC in a typical neighborhood strip center
# (≤ 50k SF). Based on ICSC / ULI benchmarks.
# 'weight' lets you prioritise certain categories in gap scoring.
# ════════════════════════════════════════════════════════════════════════════

BENCHMARK_MIX: dict[str, dict] = {
    "5411": {"ideal": 1, "weight": 3, "label": "Grocery / Specialty Food"},
    "5461": {"ideal": 1, "weight": 1, "label": "Bakery"},
    "5812": {"ideal": 4, "weight": 3, "label": "Eating Places / Restaurant"},
    "5813": {"ideal": 1, "weight": 1, "label": "Bar / Tavern"},
    "5912": {"ideal": 1, "weight": 2, "label": "Pharmacy / Drug Store"},
    "5921": {"ideal": 1, "weight": 1, "label": "Liquor Store"},
    "5651": {"ideal": 1, "weight": 1, "label": "Clothing / Apparel"},
    "5661": {"ideal": 1, "weight": 1, "label": "Shoe Store"},
    "5731": {"ideal": 1, "weight": 1, "label": "Electronics / Phone Repair"},
    "5941": {"ideal": 1, "weight": 1, "label": "Sporting Goods"},
    "5944": {"ideal": 1, "weight": 1, "label": "Jewelry Store"},
    "5945": {"ideal": 1, "weight": 1, "label": "Toy / Hobby Store"},
    "5992": {"ideal": 1, "weight": 1, "label": "Florist"},
    "5999": {"ideal": 1, "weight": 1, "label": "Pet Store / Supplies"},
    "6021": {"ideal": 1, "weight": 2, "label": "Bank"},
    "6531": {"ideal": 1, "weight": 1, "label": "Real Estate Agency"},
    "7211": {"ideal": 1, "weight": 2, "label": "Laundry / Dry Cleaning"},
    "7231": {"ideal": 2, "weight": 2, "label": "Hair / Nail / Beauty Salon"},
    "7291": {"ideal": 1, "weight": 1, "label": "Tax Preparation"},
    "7299": {"ideal": 1, "weight": 1, "label": "Spa / Personal Services"},
    "7334": {"ideal": 1, "weight": 1, "label": "Print / Copy Center"},
    "7538": {"ideal": 1, "weight": 1, "label": "Auto Repair"},
    "7991": {"ideal": 1, "weight": 2, "label": "Fitness / Gym"},
    "8011": {"ideal": 1, "weight": 2, "label": "Medical / Urgent Care"},
    "8021": {"ideal": 1, "weight": 2, "label": "Dentist"},
    "8049": {"ideal": 1, "weight": 1, "label": "Physical Therapist"},
    "8111": {"ideal": 1, "weight": 1, "label": "Law Office"},
    "8299": {"ideal": 1, "weight": 1, "label": "Educational / Tutoring"},
    "8351": {"ideal": 1, "weight": 1, "label": "Child Care / Daycare"},
    "8721": {"ideal": 1, "weight": 1, "label": "Accounting / Tax Services"},
}

# Google Places search keyword for each SIC
SIC_SEARCH_KEYWORD: dict[str, str] = {
    "5411": "grocery store",
    "5461": "bakery",
    "5812": "restaurant",
    "5813": "bar",
    "5912": "pharmacy",
    "5921": "liquor store",
    "5651": "clothing store",
    "5661": "shoe store",
    "5731": "phone repair electronics store",
    "5941": "sporting goods store",
    "5944": "jewelry store",
    "5945": "toy store",
    "5992": "florist",
    "5999": "pet store",
    "6021": "bank",
    "6531": "real estate agency",
    "7211": "laundry",
    "7231": "hair salon",
    "7291": "tax preparation",
    "7299": "spa",
    "7334": "print shop",
    "7538": "auto repair shop",
    "7991": "gym fitness center",
    "8011": "urgent care clinic",
    "8021": "dentist",
    "8049": "physical therapist",
    "8111": "law office",
    "8299": "tutoring center",
    "8351": "daycare child care",
    "8721": "accounting cpa",
}


# ════════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════════

def _print_table(rows: list[list], headers: list[str]) -> None:
    if HAS_TABULATE:
        print(tabulate(rows, headers=headers, tablefmt="simple"))
    else:
        # Fallback: fixed-width print
        col_widths = [max(len(str(h)), max((len(str(r[i])) for r in rows), default=0))
                      for i, h in enumerate(headers)]
        fmt = "  ".join(f"{{:<{w}}}" for w in col_widths)
        print(fmt.format(*headers))
        print("  ".join("-" * w for w in col_widths))
        for row in rows:
            print(fmt.format(*row))


def _miles_to_meters(miles: float) -> int:
    return int(miles * 1_609.344)


def _dist_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    return geodesic((lat1, lng1), (lat2, lng2)).miles


def _sic_from_types(types: list[str]) -> str:
    """Return the first matching SIC code (most-specific wins due to dict order)."""
    for t in types:
        if t in GOOGLE_TYPE_TO_SIC:
            return GOOGLE_TYPE_TO_SIC[t]
    return "9999"


def _fetch_all_nearby(gmaps_client, location: tuple, radius_m: int) -> list[dict]:
    """Fetch all nearby establishments, following next_page_token pagination."""
    results = []
    response = gmaps_client.places_nearby(
        location=location,
        radius=radius_m,
        type="establishment",
    )
    results.extend(response.get("results", []))

    while token := response.get("next_page_token"):
        time.sleep(2)          # Google requires a short delay before using the token
        response = gmaps_client.places_nearby(
            location=location,
            radius=radius_m,
            page_token=token,
        )
        results.extend(response.get("results", []))

    return results


def _fetch_place_details(gmaps_client, place_id: str, cache: dict) -> dict:
    """Fetch place details with a simple in-memory cache to avoid duplicate calls."""
    if place_id in cache:
        return cache[place_id]
    time.sleep(0.05)           # gentle rate-limit (~20 req/s)
    detail = gmaps_client.place(
        place_id=place_id,
        fields=["name", "formatted_address", "geometry", "types", "business_status"],
    )["result"]
    cache[place_id] = detail
    return detail


def _export_results(
    df_tenants: pd.DataFrame,
    df_gaps: pd.DataFrame,
    df_candidates: pd.DataFrame,
    config: dict,
) -> Path:
    """Export all dataframes to Excel (multi-sheet) or CSV fallback."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    center_name = config.get("center_name", "center").replace(" ", "_")

    if HAS_OPENPYXL:
        out_path = Path(f"gap_analysis_{center_name}_{stamp}.xlsx")
        with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
            df_tenants.to_excel(writer, sheet_name="Tenants", index=False)
            df_gaps.to_excel(writer, sheet_name="Gap Analysis", index=False)
            df_candidates.to_excel(writer, sheet_name="Candidates", index=False)
        print(f"\nExported to {out_path}")
    else:
        for name, df in [("tenants", df_tenants), ("gaps", df_gaps), ("candidates", df_candidates)]:
            out_path = Path(f"{name}_{center_name}_{stamp}.csv")
            df.to_csv(out_path, index=False)
            print(f"Exported to {out_path}")
        out_path = Path(f"tenants_{center_name}_{stamp}.csv")

    return out_path


# ════════════════════════════════════════════════════════════════════════════
# MAIN STEPS
# ════════════════════════════════════════════════════════════════════════════

def step1_get_tenants(gmaps_client, config: dict) -> pd.DataFrame:
    """Discover all tenants inside the shopping center radius."""
    lat, lng = config["lat"], config["lng"]
    radius_m = config["center_radius_m"]
    location = (lat, lng)

    print(f"\n{'='*60}")
    print(f"Step 1 — Fetching tenants within {radius_m}m of ({lat}, {lng})")
    print("="*60)

    raw_places = _fetch_all_nearby(gmaps_client, location, radius_m)
    print(f"Found {len(raw_places)} place entries — fetching details…")

    detail_cache: dict = {}
    tenants = []
    for place in raw_places:
        detail = _fetch_place_details(gmaps_client, place["place_id"], detail_cache)

        # Skip permanently closed businesses
        if detail.get("business_status") == "CLOSED_PERMANENTLY":
            continue

        geom = detail.get("geometry", {}).get("location", {})
        tenants.append({
            "name":         detail.get("name", "Unknown"),
            "address":      detail.get("formatted_address", ""),
            "google_types": detail.get("types", []),
            "lat":          geom.get("lat"),
            "lng":          geom.get("lng"),
            "place_id":     place["place_id"],
        })

    df = pd.DataFrame(tenants)
    if df.empty:
        print("  No tenants found. Check your coordinates and center radius.")
        return df

    df["sic"]       = df["google_types"].apply(_sic_from_types)
    df["sic_label"] = df["sic"].map(SIC_LABELS).fillna("Unknown")
    df["google_types"] = df["google_types"].apply(lambda x: ", ".join(x))

    rows = [[r["name"], r["sic"], r["sic_label"]] for _, r in df.iterrows()]
    _print_table(rows, ["Name", "SIC", "Category"])
    return df


def step2_gap_analysis(df_tenants: pd.DataFrame, top_n: int = 15) -> pd.DataFrame:
    """Compare current tenant mix to benchmark; return top N gaps."""
    print(f"\n{'='*60}")
    print(f"Step 2 — Identifying top {top_n} missing SIC categories")
    print("="*60)

    current_counts = df_tenants["sic"].value_counts().to_dict() if not df_tenants.empty else {}

    gaps = []
    for sic, info in BENCHMARK_MIX.items():
        current = current_counts.get(sic, 0)
        raw_gap = info["ideal"] - current
        if raw_gap > 0:
            score = raw_gap * info["weight"]   # weighted gap score
            gaps.append({
                "sic":       sic,
                "label":     info["label"],
                "ideal":     info["ideal"],
                "current":   current,
                "gap":       raw_gap,
                "score":     score,
            })

    gaps.sort(key=lambda x: (-x["score"], -x["gap"], x["sic"]))
    top_gaps = gaps[:top_n]

    df_gaps = pd.DataFrame(top_gaps)

    rows = [[g["sic"], g["label"], g["current"], g["ideal"], g["gap"], g["score"]]
            for g in top_gaps]
    _print_table(rows, ["SIC", "Category", "Current", "Ideal", "Gap", "Score"])
    return df_gaps


def step3_find_candidates(
    gmaps_client,
    df_gaps: pd.DataFrame,
    config: dict,
    total_candidates: int = 20,
) -> pd.DataFrame:
    """
    For each missing SIC find businesses beyond the exclusion radius
    (default 5 mi) but within the wider search radius (default 15 mi).
    Collect up to `total_candidates` across all gaps, distributed fairly.
    """
    lat, lng         = config["lat"], config["lng"]
    excl_mi          = config["exclusion_radius_mi"]
    search_mi        = config["candidate_search_radius_mi"]
    search_m         = _miles_to_meters(search_mi)

    print(f"\n{'='*60}")
    print(f"Step 3 — Finding up to {total_candidates} candidates")
    print(f"         Search radius: {search_mi} mi  |  Exclusion: {excl_mi} mi")
    print("="*60)

    if df_gaps.empty:
        print("  No gaps found — nothing to search.")
        return pd.DataFrame()

    per_sic = max(1, total_candidates // len(df_gaps))
    detail_cache: dict = {}
    all_candidates: list[dict] = []
    seen_place_ids: set = set()

    for _, row in df_gaps.iterrows():
        sic     = row["sic"]
        label   = row["label"]
        keyword = SIC_SEARCH_KEYWORD.get(sic, label)

        print(f"  Searching '{keyword}' for SIC {sic} …", end=" ", flush=True)

        try:
            response = gmaps_client.places(
                query=keyword,
                location=(lat, lng),
                radius=search_m,
            )
        except Exception as exc:
            print(f"API error: {exc}")
            continue

        found_for_sic = 0
        for p in response.get("results", []):
            if found_for_sic >= per_sic:
                break
            pid = p.get("place_id", "")
            if pid in seen_place_ids:
                continue

            try:
                detail = _fetch_place_details(gmaps_client, pid, detail_cache)
            except Exception:
                continue

            if detail.get("business_status") == "CLOSED_PERMANENTLY":
                continue

            geom = detail.get("geometry", {}).get("location", {})
            plat, plng = geom.get("lat"), geom.get("lng")
            if plat is None or plng is None:
                continue

            dist = _dist_mi(lat, lng, plat, plng)
            if dist <= excl_mi:   # skip businesses already in the trade area
                continue

            seen_place_ids.add(pid)
            all_candidates.append({
                "name":        detail.get("name", "Unknown"),
                "sic":         sic,
                "sic_label":   label,
                "distance_mi": round(dist, 1),
                "address":     detail.get("formatted_address", ""),
                "lat":         plat,
                "lng":         plng,
                "place_id":    pid,
            })
            found_for_sic += 1

        print(f"{found_for_sic} found")

        # Also follow next_page_token if we still need more for this SIC
        page_token = response.get("next_page_token")
        while page_token and found_for_sic < per_sic:
            time.sleep(2)
            try:
                response = gmaps_client.places(
                    query=keyword,
                    location=(lat, lng),
                    radius=search_m,
                    page_token=page_token,
                )
            except Exception:
                break
            for p in response.get("results", []):
                if found_for_sic >= per_sic:
                    break
                pid = p.get("place_id", "")
                if pid in seen_place_ids:
                    continue
                try:
                    detail = _fetch_place_details(gmaps_client, pid, detail_cache)
                except Exception:
                    continue
                if detail.get("business_status") == "CLOSED_PERMANENTLY":
                    continue
                geom = detail.get("geometry", {}).get("location", {})
                plat, plng = geom.get("lat"), geom.get("lng")
                if plat is None or plng is None:
                    continue
                dist = _dist_mi(lat, lng, plat, plng)
                if dist <= excl_mi:
                    continue
                seen_place_ids.add(pid)
                all_candidates.append({
                    "name":        detail.get("name", "Unknown"),
                    "sic":         sic,
                    "sic_label":   label,
                    "distance_mi": round(dist, 1),
                    "address":     detail.get("formatted_address", ""),
                    "lat":         plat,
                    "lng":         plng,
                    "place_id":    pid,
                })
                found_for_sic += 1
            page_token = response.get("next_page_token")

    # Trim to requested total and sort by distance
    df_candidates = (
        pd.DataFrame(all_candidates)
        .sort_values("distance_mi")
        .head(total_candidates)
        .reset_index(drop=True)
    )

    if df_candidates.empty:
        print("  No candidates found.")
        return df_candidates

    rows = [
        [r["name"], r["sic"], r["sic_label"], f"{r['distance_mi']} mi", r["address"]]
        for _, r in df_candidates.iterrows()
    ]
    _print_table(rows, ["Name", "SIC", "Category", "Distance", "Address"])
    return df_candidates


# ════════════════════════════════════════════════════════════════════════════
# CLI & CONFIG
# ════════════════════════════════════════════════════════════════════════════

def _load_config(args: argparse.Namespace) -> dict:
    """Merge config file (if supplied) with CLI args. CLI args take precedence."""
    cfg: dict = {}

    if args.config:
        cfg_path = Path(args.config)
        if not cfg_path.exists():
            sys.exit(f"Config file not found: {cfg_path}")
        cfg = json.loads(cfg_path.read_text())

    # CLI overrides
    for key, attr in [
        ("api_key",                  "key"),
        ("lat",                      "lat"),
        ("lng",                      "lng"),
        ("center_name",              "name"),
        ("center_radius_m",          "center_radius"),
        ("exclusion_radius_mi",      "exclusion_radius"),
        ("candidate_search_radius_mi", "search_radius"),
    ]:
        val = getattr(args, attr, None)
        if val is not None:
            cfg[key] = val

    # Defaults
    cfg.setdefault("center_name",              "shopping_center")
    cfg.setdefault("center_radius_m",          200)
    cfg.setdefault("exclusion_radius_mi",      5.0)
    cfg.setdefault("candidate_search_radius_mi", 15.0)

    # Validate required fields
    for required in ("api_key", "lat", "lng"):
        if not cfg.get(required):
            sys.exit(
                f"Missing required config: '{required}'. "
                "Provide via --config file or CLI flag (--key / --lat / --lng)."
            )

    return cfg


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Shopping Center Gap Analysis — find missing tenant categories.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--config",            help="Path to JSON config file")
    p.add_argument("--key",               help="Google Places API key")
    p.add_argument("--lat",  type=float,  help="Shopping center latitude")
    p.add_argument("--lng",  type=float,  help="Shopping center longitude")
    p.add_argument("--name",              help="Friendly center name (used in filenames)",
                   default="shopping_center")
    p.add_argument("--center-radius",     type=int,   default=None,
                   dest="center_radius",
                   help="Radius in metres to capture the center (default 200)")
    p.add_argument("--exclusion-radius",  type=float, default=None,
                   dest="exclusion_radius",
                   help="Miles — candidates inside this radius are excluded (default 5)")
    p.add_argument("--search-radius",     type=float, default=None,
                   dest="search_radius",
                   help="Miles — wider candidate search radius (default 15)")
    p.add_argument("--top-gaps",          type=int,   default=15,
                   dest="top_gaps",
                   help="Number of missing SIC gaps to report (default 15)")
    p.add_argument("--candidates",        type=int,   default=20,
                   help="Number of relocation candidates to find (default 20)")
    return p


# ════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = build_arg_parser()
    args   = parser.parse_args()
    config = _load_config(args)

    print("\n" + "="*60)
    print(f"  Shopping Center Gap Analysis")
    print(f"  Center : {config['center_name']}")
    print(f"  Coords : ({config['lat']}, {config['lng']})")
    print(f"  Date   : {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("="*60)

    gmaps_client = googlemaps.Client(key=config["api_key"])

    # ── Step 1: get tenants ──────────────────────────────────────────────
    df_tenants = step1_get_tenants(gmaps_client, config)

    # ── Step 2: gap analysis ─────────────────────────────────────────────
    df_gaps = step2_gap_analysis(df_tenants, top_n=args.top_gaps)

    # ── Step 3: find candidates ──────────────────────────────────────────
    df_candidates = step3_find_candidates(
        gmaps_client, df_gaps, config, total_candidates=args.candidates
    )

    # ── Export ────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("Exporting results…")
    # Drop place_id from exports (internal use only)
    _export_results(
        df_tenants.drop(columns=["place_id"], errors="ignore"),
        df_gaps,
        df_candidates.drop(columns=["place_id"], errors="ignore"),
        config,
    )

    print("\nDone.")


if __name__ == "__main__":
    main()
