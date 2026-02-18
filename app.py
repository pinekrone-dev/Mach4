"""
Shopping Center Gap Analysis — Streamlit Web App
================================================
Run with:
    streamlit run app.py

Then open http://localhost:8501 in your browser.
"""

import io

import googlemaps
import pandas as pd
import streamlit as st

from shopping_center_gap import (
    HAS_OPENPYXL,
    BENCHMARK_MIX,
    SIC_LABELS,
    step1_get_tenants,
    step2_gap_analysis,
    step3_find_candidates,
)

# ── Page setup ───────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="Shopping Center Gap Analysis",
    page_icon="🏬",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.title("🏬 Shopping Center Gap Analysis")
st.caption(
    "Discover your tenant mix, identify missing categories, and surface "
    "relocation candidates — powered by Google Places."
)

# ── Sidebar — configuration ──────────────────────────────────────────────────

with st.sidebar:
    st.header("Configuration")

    api_key = st.text_input(
        "Google Places API Key",
        type="password",
        help="Get a free key at console.cloud.google.com → Places API",
    )

    st.divider()
    st.subheader("Shopping Center")

    center_name = st.text_input("Center Name", value="My Shopping Center")

    col_lat, col_lng = st.columns(2)
    with col_lat:
        lat = st.number_input("Latitude", value=33.6583, format="%.6f", step=0.0001)
    with col_lng:
        lng = st.number_input("Longitude", value=-117.8667, format="%.6f", step=0.0001)

    center_radius_m = st.number_input(
        "Center radius (meters)",
        value=200,
        min_value=50,
        max_value=2_000,
        step=50,
        help="Tight radius around the center to capture only its tenants.",
    )

    st.divider()
    st.subheader("Analysis Options")

    top_gaps = st.slider("Missing categories to find", 5, 30, 15)
    num_candidates = st.slider("Candidates to surface", 5, 50, 20)

    exclusion_mi = st.slider(
        "Exclusion radius (mi)",
        1.0, 20.0, 5.0, 0.5,
        help="Candidates already inside this radius are excluded.",
    )
    search_mi = st.slider(
        "Candidate search radius (mi)",
        5.0, 50.0, 15.0, 1.0,
        help="How far out to search for candidates.",
    )

    st.divider()
    run_btn = st.button("Run Analysis", type="primary", use_container_width=True)

# ── Show center pin before running ──────────────────────────────────────────

st.subheader("Center Location")
st.map(
    pd.DataFrame({"lat": [lat], "lon": [lng]}),
    zoom=13,
    use_container_width=True,
)

# ── Guard: need API key and button ──────────────────────────────────────────

if not run_btn:
    st.info("Configure the center in the sidebar, then click **Run Analysis**.")
    st.stop()

if not api_key:
    st.error("Enter your Google Places API key in the sidebar before running.")
    st.stop()

# ── Build config dict (mirrors CLI structure) ────────────────────────────────

config = {
    "api_key":                    api_key,
    "center_name":                center_name,
    "lat":                        lat,
    "lng":                        lng,
    "center_radius_m":            center_radius_m,
    "exclusion_radius_mi":        exclusion_mi,
    "candidate_search_radius_mi": search_mi,
}

try:
    gmaps_client = googlemaps.Client(key=api_key)
except Exception as exc:
    st.error(f"Could not initialise Google Maps client: {exc}")
    st.stop()

# ── Step 1: Tenants ──────────────────────────────────────────────────────────

with st.status("Step 1 — Fetching tenants inside the center…", expanded=True) as status:
    st.write(f"Searching within **{center_radius_m} m** of ({lat:.5f}, {lng:.5f})")
    try:
        df_tenants = step1_get_tenants(gmaps_client, config)
    except Exception as exc:
        status.update(label="Step 1 failed", state="error")
        st.error(f"Google Places error: {exc}")
        st.stop()

    if df_tenants.empty:
        status.update(label="No tenants found — check your coordinates.", state="error")
        st.warning(
            "No tenants were returned. Try increasing the center radius "
            "or verify the coordinates point inside the shopping center."
        )
        st.stop()

    status.update(
        label=f"Step 1 complete — {len(df_tenants)} tenants found",
        state="complete",
    )

# ── Step 2: Gap analysis ─────────────────────────────────────────────────────

with st.status("Step 2 — Analysing tenant mix gaps…", expanded=False) as status:
    df_gaps = step2_gap_analysis(df_tenants, top_n=top_gaps)
    status.update(
        label=f"Step 2 complete — {len(df_gaps)} missing categories identified",
        state="complete",
    )

# ── Step 3: Candidates ───────────────────────────────────────────────────────

with st.status(
    f"Step 3 — Searching for {num_candidates} relocation candidates…",
    expanded=True,
) as status:
    st.write(
        f"Looking up to **{search_mi} mi** away, "
        f"excluding within **{exclusion_mi} mi**"
    )
    try:
        df_candidates = step3_find_candidates(
            gmaps_client, df_gaps, config, total_candidates=num_candidates
        )
    except Exception as exc:
        status.update(label="Step 3 failed", state="error")
        st.error(f"Candidate search error: {exc}")
        df_candidates = pd.DataFrame()

    status.update(
        label=f"Step 3 complete — {len(df_candidates)} candidates found",
        state="complete",
    )

st.success("Analysis complete!")

# ── Summary metrics ──────────────────────────────────────────────────────────

c1, c2, c3, c4 = st.columns(4)
c1.metric("Tenants found", len(df_tenants))
c2.metric("Unique SIC codes", df_tenants["sic"].nunique() if not df_tenants.empty else 0)
c3.metric("Missing categories", len(df_gaps))
c4.metric("Candidates surfaced", len(df_candidates))

# ── Results tabs ─────────────────────────────────────────────────────────────

tab1, tab2, tab3, tab4 = st.tabs(
    ["Tenants", "Gap Analysis", "Candidates", "Maps"]
)

# ── Tab 1: Tenants ────────────────────────────────────────────────────────────

with tab1:
    st.subheader(f"Current Tenants ({len(df_tenants)})")

    display_cols = [c for c in ["name", "sic", "sic_label", "address"] if c in df_tenants.columns]
    st.dataframe(
        df_tenants[display_cols],
        use_container_width=True,
        hide_index=True,
    )

    # SIC breakdown bar chart
    sic_counts = (
        df_tenants.groupby(["sic", "sic_label"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
    )
    if not sic_counts.empty:
        st.subheader("Tenant mix by category")
        st.bar_chart(
            sic_counts.set_index("sic_label")["count"],
            use_container_width=True,
        )

# ── Tab 2: Gap Analysis ───────────────────────────────────────────────────────

with tab2:
    st.subheader(f"Top {top_gaps} Missing Categories")
    st.caption(
        "**Score** = gap × category weight. Higher = higher priority to fill."
    )

    if not df_gaps.empty:
        # Highlight score column
        styled = df_gaps.style.background_gradient(subset=["score"], cmap="Reds")
        st.dataframe(styled, use_container_width=True, hide_index=True)

        st.subheader("Gap scores")
        st.bar_chart(
            df_gaps.set_index("label")["score"],
            use_container_width=True,
        )
    else:
        st.success("No significant gaps found — the center has a well-rounded tenant mix!")

# ── Tab 3: Candidates ─────────────────────────────────────────────────────────

with tab3:
    st.subheader(f"Relocation Candidates ({len(df_candidates)})")
    st.caption(
        f"Businesses **{exclusion_mi}–{search_mi} miles** from the center, "
        "sorted by distance."
    )

    if not df_candidates.empty:
        cand_display = [
            c for c in ["name", "sic_label", "distance_mi", "address"]
            if c in df_candidates.columns
        ]
        st.dataframe(
            df_candidates[cand_display],
            use_container_width=True,
            hide_index=True,
        )
    else:
        st.info("No candidates found with the current search settings.")

# ── Tab 4: Maps ───────────────────────────────────────────────────────────────

with tab4:
    st.subheader("Tenant locations")
    if not df_tenants.empty and {"lat", "lng"}.issubset(df_tenants.columns):
        tenant_map_df = df_tenants.rename(columns={"lng": "lon"})[["lat", "lon"]]
        st.map(tenant_map_df, zoom=14, use_container_width=True)

    if not df_candidates.empty and {"lat", "lng"}.issubset(df_candidates.columns):
        st.subheader("Candidate locations")
        cand_map = df_candidates.assign(lon=df_candidates["lng"])[["lat", "lon"]]
        st.map(cand_map, zoom=11, use_container_width=True)
    elif not df_candidates.empty:
        st.info("Candidate coordinates not available for mapping.")

# ── Download ──────────────────────────────────────────────────────────────────

st.divider()
st.subheader("Download Report")

export_tenants   = df_tenants.drop(columns=["place_id", "google_types"], errors="ignore")
export_gaps      = df_gaps
export_candidates = df_candidates.drop(columns=["place_id"], errors="ignore")

if HAS_OPENPYXL:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        export_tenants.to_excel(writer, sheet_name="Tenants", index=False)
        export_gaps.to_excel(writer, sheet_name="Gap Analysis", index=False)
        export_candidates.to_excel(writer, sheet_name="Candidates", index=False)

    st.download_button(
        label="Download Excel report (.xlsx)",
        data=buf.getvalue(),
        file_name=f"gap_analysis_{center_name.replace(' ', '_')}.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        use_container_width=True,
    )
else:
    # CSV fallback — offer each table individually
    col_a, col_b, col_c = st.columns(3)
    with col_a:
        st.download_button(
            "Tenants CSV",
            export_tenants.to_csv(index=False),
            file_name="tenants.csv",
            mime="text/csv",
            use_container_width=True,
        )
    with col_b:
        st.download_button(
            "Gaps CSV",
            export_gaps.to_csv(index=False),
            file_name="gaps.csv",
            mime="text/csv",
            use_container_width=True,
        )
    with col_c:
        st.download_button(
            "Candidates CSV",
            export_candidates.to_csv(index=False),
            file_name="candidates.csv",
            mime="text/csv",
            use_container_width=True,
        )
