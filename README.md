# Abstract

Archaeological data as pulled from the Laboratory of Spatial Archaeology; used for in-progress population estimations by Confoederatio. The original data portal these files were pulled from is available here: https://archaeolog.ru/oanmap/.

# Periodization

| # | File Prefix & epoch_id | Russian / English Name | Core IA RAS Date Range | Regional / Extended Span | True Sites |
| :---: | :--- | :--- | :--- | :--- | ---: |
| 01 | 01_stone_age_e52 | Каменный Век; Stone Age | c. 2,6M – 3000 BC | To c. 2000–1500 BC in northern taiga & Siberia | 6 221 |
| 02 | 02_eneolithic_e13 | Энеолит; Eneolithic (Copper Age) | c. 4500 – 3000 BC | c. 3500 – 2000 BC in forest-steppe, Urals & W. Siberia | 1 026 |
| 03 | 03_palaeometal_e22 | Палеометалл; Palaeometal Period | c. 3000 – 300 BC | c. 1500 BC – 300 AD in Russian Far East & Yakutia | 386 |
| 04 | 04_early_metal_age_e21 | Эпоха Раннего Металла; Early Metal Age | c. 3500 – 500 BC | Karelia, Kola & northern forest zone (Eneolithic + Bronze) | 132 |
| 05 | 05_bronze_age_e47 | Бронзовый Век; Bronze Age | c. 3300 – 800 BC | Early (3300–2500), Middle (2500–1800), Late (1800–800 BC) | 9 654 |
| 06 | 06_iron_age_e36 | Железный век; Early Iron Age | c. 800 BC – 400 AD | To c. 500–700 AD in forest zone & Siberia | 9 180 |
| 07 | 07_classical_antiquity_e6 | Античное Время; Classical Antiquity | c. 600 BC – 400 AD | Northern Black Sea littoral (Crimea, Taman, Lower Don) | 812 |
| 08 | 08_migration_period_e34 | Эпоха Великого переселения народов; Migration Period | c. 350 – 700 AD | Late 4th – 7th c. AD (Hunnic to early Slavic/Khazar horizon) | 10 |
| 09 | 09_middle_ages_e37 | Эпоха Средневековья; Middle Ages | c. 400 – 1600 AD | Early (5th–9th c.), Pre-Mongol (10th–13th c.), Late (13th–16th c.) | 14 764 |
| 10 | 10_early_modern_17_18c_e3 | Новое Время (17-18 вв.); Early Modern Period | 1600 – 1800 AD | 17th – 18th centuries AD (late Tsardom & early Empire) | 3 480 |
| 11 | 11_modern_e18 | Новейшее время; Contemporary Period | 1800 – c. 1925 AD | 19th – early 20th c. AD (>100 years old under Law 73-FZ, plus WWII) | 1 335 |
| 12 | 12_unspecified_e_neg1 | Не указано; Unspecified Period | Undated | Survey monuments lacking diagnostic dating material | 20 205 |

# Kriged & Substrata Population Rasters

The `krige_sites_ia_ras.js` and `SitesIARASResidualKriging.js` pipeline (`SitesIARASKriging` / `SitesIARASResidualKriging`) generates two 5-arcminute (`4320 x 2160`, WGS84 equirectangular `float32` RGBA GeoPNG) raster directories constrained strictly to the land area of the modern Russian Federation (excluding Kaliningrad, `oblast_id: 1217`) and adding Crimea (Republic of Crimea `5319` and Sevastopol `5346`, `412 959` valid land cells covering `16,56M km²`):

- `1.kriged_rasters/` — Contains the `12` parameter-free empirical non-stationary Paciorek–Schervish Matérn ($\nu = 3/2$) Log-Linear Residual Kriging rasters (`01_stone_age_e52.png` through `12_unspecified_e_neg1.png`) solved over `1 991` regular administrative districts (*raions*) using Clayton–Kaldor / Cressie (1993) Empirical Bayes oblast-prior density shrinkage, Freeman–Tukey variance-stabilising square-root site densities $Z_{k,p} = \sqrt{\lambda_{k,p}}$, Matheron (1962) method-of-moments empirical variograms, empirical zero-lag nugget intercepts $c_0$, continuous grid-smoothed catchment radii and parameter-free Log-Linear Residual Kriging coupling de-cliffed `population_Stadester` habitation ($u_{\text{hab}, t}(\mathbf{x})$) with Climber3 biophysical suitability (`maxln_cr.asc`) and WWF forest-steppe ecotone (`forest_wwf_cr.asc`) via constrained WLS regression.
- `2.population_rasters/` — Contains the `48` HYDE benchmark population rasters from `10000 BC` up to the `1900 AD` cutoff (`popc_-10000.png` through `popc_1900.png`), produced by summing active period rasters in empirical site units at documented IA RAS chronological horizons, linearly interpolating between horizon distributions, applying parameter-free Log-Linear Residual Kriging trend weights bounded by natural features and `population_Stadester` habitation (inheriting `stadester_rural_1900.png` river/coastal habitation cells for any raion with archaeological sites where pre-modern HYDE province allocation is zero) and scaling each benchmark year to the exact Russian Federation (excluding Kaliningrad) + Crimea total population from `population_Substrata`.
- `config/oanmap_kriging_metadata.json` — Diagnostic summary containing empirical variogram parameters, WLS Residual Kriging regression coefficients ($\hat{\beta}_0, \hat{\beta}_1, \hat{\beta}_2$), quantile diagnostics (`p10`, `p50`, `p90`, `p99`, `max`) and the `-10000` to `1900 AD` `population_Substrata` population series.
