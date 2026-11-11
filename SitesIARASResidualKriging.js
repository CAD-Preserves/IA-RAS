//Import modules
let fs = require("fs");
let path = require("path");
let { PNG } = require("pngjs");
let SitesIARASGridUtils = require("./SitesIARASGridUtils.js");

//Initialise functions
{
  /**
   * Residual Kriging covariate loader, administrative de-cliffing, constrained Weighted Least Squares (WLS) trend regression and Empirical Bayes variance-partitioned Residual Kriging synthesis engine for the IA RAS (OANMAP) archaeological site dataset across the modern Russian Federation (excluding Kaliningrad) plus Crimea (-10000 to 1900 AD).
   *
   * @class SitesIARASResidualKriging
   * @extends SitesIARASGridUtils
   */
  global.SitesIARASResidualKriging = class extends SitesIARASGridUtils {
    /**
     * Applies a two-stage multiplicative dasymetric frontier continuity feather along Russia's western border with Estonia (233), Latvia (428), Belarus (112) and mainland Ukraine (804) using upstream urban-masked HYDE 3.5 rural density (with pre-1700 AD Wild Fields steppe suppression on open steppe), ensuring seamless cross-border continuity while preserving 5-arcminute river valleys and never including external countries in the output mask.
     * @alias SitesIARASResidualKriging.applyWesternFrontierContinuity
     *
     * @param {Object} arg0_mask_data
     * @param {Float32Array} arg1_valid_field
     * @param {Object} arg2_bio_covs
     * @param {Object} arg3_config
     * @param {number|Object} [arg4_year_or_period]
     *
     * @returns {Float32Array}
     */
    static applyWesternFrontierContinuity (
      arg0_mask_data,
      arg1_valid_field,
      arg2_bio_covs,
      arg3_config,
      arg4_year_or_period
    ) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let valid_field = arg1_valid_field;
      let bio_covs = arg2_bio_covs;
      let config = arg3_config;
      let year_or_period = arg4_year_or_period;

      //Guard clause if biophysical covariates or sub_iso_grid unavailable
      if (!bio_covs || !bio_covs.sub_iso_grid) return valid_field;

      //Declare local instance variables
      let bfs_dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
      let bfs_head = 0;
      let bfs_queue = [];
      let blur_px = 6;
      let cell_area = mask_data.cell_land_area;
      let cov_paths = (config && config.kriging_config && config.kriging_config.covariate_paths) ?
        config.kriging_config.covariate_paths : {};
      let dist_to_west;
      let ext_density_grid;
      let ext_mask;
      let forest_grid = bio_covs.forest_grid;
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let hyde_grid;
      let hyde_path;
      let hyde_year = (typeof year_or_period === "number") ? Math.max(-10000, Math.min(1900, year_or_period)) : 1000;
      let joint_density;
      let land_area_grid = mask_data.land_area_grid;
      let macro_px = 10;
      let mask_grid = mask_data.mask_grid;
      let mod_urban_mask;
      let n_valid = mask_data.valid_cell_count;
      let nearest_ext_gidx;
      let orig_rus_density;
      let out_field = new Float32Array(mask_data.valid_cell_count);
      let px_to_valid = mask_data.pixel_to_valid_idx;
      let raw_hyde;
      let rus_density = new Float32Array(mask_data.valid_cell_count);
      let scale_ext = 1.0;
      let steppe_w = (typeof year_or_period === "number") ?
        ((year_or_period <= 1600) ? 1.0 : ((year_or_period >= 1800) ? 0.0 : (1800 - year_or_period)/200)) : 0.85;
      let sub_iso_grid = bio_covs.sub_iso_grid;
      let target_indices = [];
      let total_pixels = grid_w*grid_h;
      let valid_indices = mask_data.valid_indices;
      let win_px = 7;
      let year_label = (hyde_year < 0) ? `${Math.abs(hyde_year)}BC` : `${hyde_year}AD`;

      hyde_path = path.join(
        mask_data.project_root,
        cov_paths.hyde_popc_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters_scaled_to_global",
        `popc_${hyde_year}.png`
      );
      if (!fs.existsSync(hyde_path))
        hyde_path = path.join(
          mask_data.project_root,
          cov_paths.hyde_raw_rasters_folder || "histmap/2.data_cleaning/landuse_HYDE/rasters",
          `popc_${year_label}.png`
        );
      if (!fs.existsSync(hyde_path)) return valid_field;

      raw_hyde = this.readGlobalFloat32Raster(hyde_path, total_pixels);
      mod_urban_mask = new Uint8Array(this.getModernUrbanMask(mask_data, config, null));
      ext_mask = new Uint8Array(total_pixels);

      for (let i = 0; i < total_pixels; i++) {
        if (mask_grid[i] === 1 || land_area_grid[i] <= 0) continue;

        let local_iso = Math.floor(Math.round(sub_iso_grid[i])/1000);
        let local_lat = 90 - (Math.floor(i/grid_w) + 0.5)*(180/grid_h);
        let local_lon = -180 + ((i % grid_w) + 0.5)*(360/grid_w);

        if (
          local_lat >= 46.25 &&
          local_lat <= 71.5 &&
          local_lon >= 20.0 &&
          local_lon <= 41.5 &&
          (
            local_iso === 112 ||
            local_iso === 233 ||
            local_iso === 246 ||
            local_iso === 428 ||
            local_iso === 440 ||
            local_iso === 578 ||
            local_iso === 804
          )
        ) {
          ext_mask[i] = 1;
          target_indices.push(i);
          if (
            raw_hyde[i] <= 0 &&
            local_lat >= 51.15 &&
            local_lat <= 51.85 &&
            local_lon >= 29.40 &&
            local_lon <= 30.45
          ) mod_urban_mask[i] = 1;
        }
      }

      if (target_indices.length === 0) return valid_field;

      hyde_grid = this.inpaintUrbanMaskGrid(
        raw_hyde,
        mod_urban_mask,
        land_area_grid,
        null,
        grid_w,
        grid_h,
        4,
        Int32Array.from(target_indices)
      );

      dist_to_west = new Int16Array(total_pixels);
      dist_to_west.fill(32000);
      ext_density_grid = new Float32Array(total_pixels);
      joint_density = new Float32Array(total_pixels);
      nearest_ext_gidx = new Int32Array(total_pixels);
      nearest_ext_gidx.fill(-1);

      for (let i = 0; i < n_valid; i++)
        rus_density[i] = valid_field[i]/Math.max(1, cell_area[i]);
      orig_rus_density = new Float32Array(rus_density);

      if (typeof year_or_period !== "number") {
        let local_ext_area = 0;
        let local_ext_sum = 0;
        let local_rus_area = 0;
        let local_rus_sum = 0;

        for (let i = 0; i < n_valid; i++) {
          let local_gidx = valid_indices[i];
          let local_lat = 90 - (Math.floor(local_gidx/grid_w) + 0.5)*(180/grid_h);
          let local_lon = -180 + ((local_gidx % grid_w) + 0.5)*(360/grid_w);

          if (local_lat >= 52.0 && local_lat <= 62.0 && local_lon >= 27.0 && local_lon <= 36.0) {
            local_rus_sum += valid_field[i];
            local_rus_area += cell_area[i];
          }
        }
        for (let i = 0; i < target_indices.length; i++) {
          let local_gidx = target_indices[i];
          let local_lat = 90 - (Math.floor(local_gidx/grid_w) + 0.5)*(180/grid_h);

          if (local_lat >= 52.0 && local_lat <= 62.0 && hyde_grid[local_gidx] > 0) {
            local_ext_sum += hyde_grid[local_gidx];
            local_ext_area += land_area_grid[local_gidx];
          }
        }
        if (local_rus_area > 0 && local_ext_sum > 0)
          scale_ext = (local_rus_sum/local_rus_area)/(local_ext_sum/Math.max(1, local_ext_area));
      }

      for (let i = 0; i < target_indices.length; i++) {
        let local_gidx = target_indices[i];
        let local_val = hyde_grid[local_gidx]*scale_ext;

        if (local_val > 0) {
          let local_f = (forest_grid && forest_grid[local_gidx] > 0) ? 1 : 0;
          let local_iso = Math.floor(Math.round(sub_iso_grid[local_gidx])/1000);
          let local_lon = -180 + ((local_gidx % grid_w) + 0.5)*(360/grid_w);

          if (local_iso === 804 && local_f === 0 && local_lon >= 31.0)
            local_val *= (1 - steppe_w*0.75);

          ext_density_grid[local_gidx] = local_val/Math.max(1, land_area_grid[local_gidx]);
          dist_to_west[local_gidx] = 0;
          nearest_ext_gidx[local_gidx] = local_gidx;
          bfs_queue.push(local_gidx);
        }
      }

      for (let i = 0; i < bfs_queue.length; i++) {
        let local_curr = bfs_queue[bfs_head++];
        let local_cx = local_curr % grid_w;
        let local_cy = Math.floor(local_curr/grid_w);
        let local_d = dist_to_west[local_curr];

        if (local_d >= macro_px + 4) continue;

        for (let x = 0; x < bfs_dirs.length; x++) {
          let local_nx = local_cx + bfs_dirs[x][1];
          let local_ny = local_cy + bfs_dirs[x][0];

          if (local_nx >= 0 && local_nx < grid_w && local_ny >= 0 && local_ny < grid_h) {
            let local_nlat = 90 - (local_ny + 0.5)*(180/grid_h);
            let local_nlon = -180 + (local_nx + 0.5)*(360/grid_w);
            let local_nidx = local_ny*grid_w + local_nx;

            //Never propagate mainland Kherson Wild Fields frontier feathering south across Perekop/Sivash into Crimea
            if (local_nlat < 46.23 && local_nlon >= 32.45 && local_nlon <= 36.68) continue;

            if (mask_grid[local_nidx] === 1 && dist_to_west[local_nidx] > local_d + 1) {
              dist_to_west[local_nidx] = local_d + 1;
              nearest_ext_gidx[local_nidx] = nearest_ext_gidx[local_curr];
              bfs_queue.push(local_nidx);
            }
          }
        }
      }

      //Stage 1: Meso-scale raised-cosine frontier baseline matching
      for (let i = 0; i < n_valid; i++) {
        let local_d = dist_to_west[valid_indices[i]];
        let local_dens = rus_density[i];
        let local_gidx = valid_indices[i];
        let local_near_idx = nearest_ext_gidx[local_gidx];

        if (local_d >= 1 && local_d <= macro_px && local_dens > 0 && local_near_idx >= 0) {
          let local_ext_area = 0;
          let local_ext_pop = 0;
          let local_fcx = local_near_idx % grid_w;
          let local_fcy = Math.floor(local_near_idx/grid_w);
          let local_rus_area = 0;
          let local_rus_pop = 0;

          for (let x = -win_px; x <= win_px; x++) {
            let local_ny = local_fcy + x;

            if (local_ny >= 0 && local_ny < grid_h)
              for (let y = -win_px; y <= win_px; y++) {
                let local_nx = local_fcx + y;

                if (local_nx >= 0 && local_nx < grid_w) {
                  let local_widx = local_ny*grid_w + local_nx;

                  if (ext_mask[local_widx] === 1 && ext_density_grid[local_widx] > 0) {
                    let local_a = land_area_grid[local_widx];

                    local_ext_area += local_a;
                    local_ext_pop += local_a*ext_density_grid[local_widx];
                  } else if (mask_grid[local_widx] === 1 && dist_to_west[local_widx] <= win_px) {
                    let local_v = px_to_valid[local_widx];

                    if (local_v >= 0 && orig_rus_density[local_v] > 0) {
                      let local_a = cell_area[local_v];

                      local_rus_area += local_a;
                      local_rus_pop += local_a*orig_rus_density[local_v];
                    }
                  }
                }
              }
          }

          if (local_ext_area > 0 && local_rus_area > 0) {
            let local_alpha = 0.5*(1 + Math.cos(Math.PI*(local_d - 1)/Math.max(1, macro_px)));
            let local_clamped;
            let local_ext_iso = Math.floor(Math.round(sub_iso_grid[local_near_idx])/1000);
            let local_max_r = (local_ext_iso === 233 || local_ext_iso === 246 || local_ext_iso === 428 || local_ext_iso === 578) ? 1.40 : 1.75;
            let local_min_r = (local_ext_iso === 233 || local_ext_iso === 246 || local_ext_iso === 428 || local_ext_iso === 578) ? 0.65 : 0.55;
            let local_ratio = (local_ext_pop/local_ext_area)/Math.max(1e-6, local_rus_pop/local_rus_area);

            local_clamped = Math.max(local_min_r, Math.min(local_max_r, local_ratio));
            local_dens = local_dens*Math.pow(local_clamped, local_alpha);
          }
        }

        rus_density[i] = local_dens;
        joint_density[local_gidx] = local_dens;
      }

      for (let i = 0; i < target_indices.length; i++) {
        let local_gidx = target_indices[i];

        if (ext_density_grid[local_gidx] > 0)
          joint_density[local_gidx] = ext_density_grid[local_gidx];
      }

      //Stage 2: Multiplicative meso-scale ratio feather across the immediate border (preserving 100% of 5-arcminute river valleys)
      for (let i = 0; i < n_valid; i++) {
        let local_d = dist_to_west[valid_indices[i]];
        let local_dens = rus_density[i];
        let local_gidx = valid_indices[i];

        if (local_d >= 1 && local_d <= blur_px && local_dens > 0) {
          let local_beta = 0.5*(1 + Math.cos(Math.PI*(local_d - 1)/Math.max(1, blur_px)));
          let local_cx = local_gidx % grid_w;
          let local_cy = Math.floor(local_gidx/grid_w);
          let local_int_w = 0;
          let local_int_wd = 0;
          let local_jnt_w = 0;
          let local_jnt_wd = 0;
          let local_k_rad = 5;

          for (let x = -local_k_rad; x <= local_k_rad; x++) {
            let local_ny = local_cy + x;

            if (local_ny >= 0 && local_ny < grid_h)
              for (let y = -local_k_rad; y <= local_k_rad; y++) {
                let local_nx = local_cx + y;

                if (local_nx >= 0 && local_nx < grid_w) {
                  let local_nidx = local_ny*grid_w + local_nx;
                  let local_nd = joint_density[local_nidx];

                  if (local_nd > 0 && (mask_grid[local_nidx] === 1 || ext_mask[local_nidx] === 1)) {
                    let local_w = 1/(1 + 0.25*(x*x + y*y));

                    local_jnt_w += local_w;
                    local_jnt_wd += local_w*local_nd;
                    if (mask_grid[local_nidx] === 1) {
                      local_int_w += local_w;
                      local_int_wd += local_w*local_nd;
                    }
                  }
                }
              }
          }

          if (local_jnt_w > 0 && local_int_w > 0) {
            let local_int_m = local_int_wd/local_int_w;
            let local_jnt_m = local_jnt_wd/local_jnt_w;
            let local_ratio = Math.max(0.4, Math.min(2.5, local_jnt_m/Math.max(1e-6, local_int_m)));

            local_dens = local_dens*Math.pow(local_ratio, 0.85*local_beta);
          }
        }

        out_field[i] = local_dens*cell_area[i];
      }

      //Return statement
      return out_field;
    }


    /**
     * Computes the composite de-cliffed urban-masked HYDE 3.5 rural habitation field u_hab(x) for an archaeological period by averaging across the HYDE benchmark years within its documented date range.
     * @alias SitesIARASResidualKriging.computeCompositeHabitationField
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_raion_data
     * @param {Object} arg2_bio_covs
     * @param {Object} arg3_period_config
     * @param {Object} arg4_config
     * @param {Map} arg5_hab_cache
     *
     * @returns {Float32Array}
     */
    static computeCompositeHabitationField (
      arg0_mask_data,
      arg1_raion_data,
      arg2_bio_covs,
      arg3_period_config,
      arg4_config,
      arg5_hab_cache
    ) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let raion_data = arg1_raion_data;
      let bio_covs = arg2_bio_covs;
      let period_config = arg3_period_config;
      let config = arg4_config;
      let hab_cache = arg5_hab_cache;

      //Declare local instance variables
      let composite_hab = new Float32Array(mask_data.valid_cell_count);
      let hyde_years = config.kriging_config.all_hyde_years || config.kriging_config.hyde_years;
      let matched_years = [];
      let n_valid = mask_data.valid_cell_count;
      let rep_years = [];

      if (period_config.approx_start_year !== null && period_config.approx_end_year !== null) {
        for (let i = 0; i < hyde_years.length; i++)
          if (hyde_years[i] >= period_config.approx_start_year && hyde_years[i] <= period_config.approx_end_year)
            matched_years.push(hyde_years[i]);
      }
      if (matched_years.length === 0)
        matched_years = [0, 900, 1500];

      //Select start, midpoint and end benchmark years of the period to represent its habitation footprint cleanly
      rep_years.push(matched_years[0]);
      if (matched_years.length > 2)
        rep_years.push(matched_years[Math.floor(matched_years.length/2)]);
      if (matched_years.length > 1)
        rep_years.push(matched_years[matched_years.length - 1]);

      for (let i = 0; i < rep_years.length; i++) {
        let local_u_hab = this.computeDeCliffedHabitationField(
          mask_data,
          raion_data,
          bio_covs,
          rep_years[i],
          config,
          hab_cache
        );

        for (let x = 0; x < n_valid; x++)
          composite_hab[x] += local_u_hab[x]/rep_years.length;
      }

      //Return statement
      return composite_hab;
    }


    /**
     * Computes the seamless, within-partition de-cliffed Freeman-Tukey urban-masked HYDE 3.5 rural habitation amplitude field u_hab,t(x) for a given benchmark year, preserving 5-arcminute river-valley and topographic habitation detail across Crimea, European Russia and Siberia while eliminating administrative partition boundary cliffs and urban spikes.
     * @alias SitesIARASResidualKriging.computeDeCliffedHabitationField
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_raion_data
     * @param {Object} arg2_bio_covs
     * @param {number} arg3_year
     * @param {Object} arg4_config
     * @param {Map} [arg5_hab_cache]
     *
     * @returns {Float32Array}
     */
    static computeDeCliffedHabitationField (
      arg0_mask_data,
      arg1_raion_data,
      arg2_bio_covs,
      arg3_year,
      arg4_config,
      arg5_hab_cache
    ) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let raion_data = arg1_raion_data;
      let bio_covs = arg2_bio_covs;
      let year = arg3_year;
      let config = arg4_config;
      let hab_cache = arg5_hab_cache;

      //Guard clause if already cached
      if (hab_cache && hab_cache.has(year)) return hab_cache.get(year);

      //Declare local instance variables
      let cell_area = mask_data.cell_land_area;
      let cell_raion = raion_data.cell_nearest_raion;
      let decliffed_d;
      let f_hab_smooth;
      let hab_ind = new Float32Array(mask_data.valid_cell_count);
      let hyde_rur = this.loadUrbanMaskedHYDEPopcRaster(mask_data, year, hab_cache, config);
      let hyde_rur_1900 = bio_covs.hyde_rur_1900;
      let min_hyde_area = 0.75*mask_data.mean_cell_land_area_km2;
      let n_parts = bio_covs.partition_count;
      let n_raions = raion_data.raion_count;
      let n_valid = mask_data.valid_cell_count;
      let part_cnt = new Int32Array(n_parts);
      let part_id = bio_covs.part_id;
      let part_sum = new Float64Array(n_parts);
      let raion_has_hab = new Uint8Array(n_raions);
      let raw_sqrt_d = new Float32Array(mask_data.valid_cell_count);
      let steppe_env = bio_covs.steppe_envelope;
      let steppe_w = (year <= 1600) ? 1.0 : ((year >= 1800) ? 0.0 : (1800 - year)/200);
      let u_hab = new Float32Array(mask_data.valid_cell_count);

      for (let i = 0; i < n_valid; i++)
        if (hyde_rur[i] > 0.05)
          raion_has_hab[cell_raion[i]] = 1;

      for (let i = 0; i < n_valid; i++) {
        let local_area = Math.max(min_hyde_area, cell_area[i]);
        let local_d = hyde_rur[i]/local_area;
        let local_r = cell_raion[i];

        if (local_d <= 0 && raion_has_hab[local_r] === 0 && bio_covs.raion_has_any_sites[local_r] === 1)
          local_d = 0.15*(hyde_rur_1900[i]/local_area);

        //Treat sub-person HYDE background dust (< 0,002 people/km2 in zero-site raions) as genuinely uninhabited
        if (local_d < 0.002 && bio_covs.raion_has_any_sites[local_r] === 0)
          local_d = 0;

        if (local_d > 0) {
          let local_pid = part_id[i];
          let local_s = Math.sqrt(local_d);

          hab_ind[i] = 1;
          raw_sqrt_d[i] = local_s;
          part_cnt[local_pid]++;
          part_sum[local_pid] += local_s;
        }
      }

      //Within-partition local positive normalisation preserving 100% of 5-arcminute river-valley and topographic detail
      f_hab_smooth = this.smoothValidFieldOnGrid(mask_data, hab_ind, Math.max(1, bio_covs.catchment_px));
      decliffed_d = this.smoothWithinPartitionPositive(
        mask_data,
        raw_sqrt_d,
        part_id,
        part_sum,
        part_cnt,
        Math.max(5, bio_covs.meso_px)
      );

      for (let i = 0; i < n_valid; i++)
        if (decliffed_d[i] > 0) {
          let local_env = (steppe_env) ? (1 - steppe_w*(1 - steppe_env[i])) : 1.0;

          u_hab[i] = Math.sqrt(Math.max(0, f_hab_smooth[i]))*decliffed_d[i]*local_env;
        }

      if (hab_cache)
        hab_cache.set(year, u_hab);

      //Return statement
      return u_hab;
    }


    /**
     * Fits the constrained non-negative Weighted Least Squares (WLS) covariate regression trend m_hat(x) predicting observed raion site amplitudes z_obs from [u_hab, u_hab*u_nat, u_hab*u_eco] and computes the Empirical Bayes variance-partitioned Residual Kriging synthesis coupling the covariate drift m_hat(x) with the kriged archaeological potential.
     * @alias SitesIARASResidualKriging.computeResidualKrigingWeights
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_raion_data
     * @param {Object} arg2_bio_covs
     * @param {Float32Array} arg3_u_hab
     * @param {Float64Array} arg4_z_obs
     * @param {number} arg5_meso_px
     * @param {Float32Array} [arg6_arch_potential]
     *
     * @returns {Object}
     */
    static computeResidualKrigingWeights (
      arg0_mask_data,
      arg1_raion_data,
      arg2_bio_covs,
      arg3_u_hab,
      arg4_z_obs,
      arg5_meso_px,
      arg6_s_obs
    ) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let raion_data = arg1_raion_data;
      let bio_covs = arg2_bio_covs;
      let u_hab = arg3_u_hab;
      let z_obs = arg4_z_obs;
      let meso_px = arg5_meso_px;
      let s_obs = arg6_s_obs;

      //Declare local instance variables
      let beta = new Float64Array(3);
      let b0_eff;
      let b1_eff;
      let b2_eff;
      let b_sum;
      let cell_area = mask_data.cell_land_area;
      let cell_raion = raion_data.cell_nearest_raion;
      let dom_count = raion_data.domestic_raion_count || raion_data.raion_count;
      let m_cell = new Float32Array(mask_data.valid_cell_count);
      let m_macro;
      let macro_rad = Math.max(4, Math.round(0.75*meso_px));
      let n_covs = 3;
      let n_valid = mask_data.valid_cell_count;
      let r_eco_mean = new Float64Array(dom_count);
      let r_hab_area = new Float64Array(dom_count);
      let r_hab_mean = new Float64Array(dom_count);
      let r_nat_mean = new Float64Array(dom_count);
      let u_eco = bio_covs.u_eco;
      let u_nat = bio_covs.u_nat;
      let weights = new Float32Array(mask_data.valid_cell_count);
      let xtx = new Float64Array(9);
      let xty = new Float64Array(3);

      //Aggregate inhabited covariate means per domestic raion catchment
      for (let i = 0; i < n_valid; i++) {
        let local_uh = u_hab[i];

        if (local_uh <= 0) continue;

        let local_a = cell_area[i];
        let local_r = cell_raion[i];

        if (local_r >= dom_count) continue;

        r_hab_area[local_r] += local_a;
        r_hab_mean[local_r] += local_a*local_uh;
        r_nat_mean[local_r] += local_a*local_uh*u_nat[i];
        r_eco_mean[local_r] += local_a*local_uh*u_eco[i];
      }

      for (let i = 0; i < dom_count; i++) {
        let local_ha = r_hab_area[i];

        if (local_ha > 0) {
          r_hab_mean[i] /= local_ha;
          r_nat_mean[i] /= local_ha;
          r_eco_mean[i] /= local_ha;
        }
      }

      //Assemble normal equations X^T W X * beta = X^T W z_obs weighted by inhabited raion area and site count support S_k
      for (let i = 0; i < dom_count; i++) {
        let local_sk = (s_obs) ? Math.max(0, s_obs[i]) : 0;
        let local_w = r_hab_area[i]*(1 + Math.sqrt(local_sk));

        if (local_w <= 0) continue;

        let local_xvec = [r_hab_mean[i], r_nat_mean[i], r_eco_mean[i]];
        let local_y = z_obs[i];

        for (let x = 0; x < n_covs; x++) {
          xty[x] += local_w*local_xvec[x]*local_y;
          for (let y = 0; y < n_covs; y++)
            xtx[x*n_covs + y] += local_w*local_xvec[x]*local_xvec[y];
        }
      }

      //Projected Gauss-Seidel Non-Negative Least Squares (NNLS) solver for beta >= 1e-4
      for (let i = 0; i < 400; i++)
        for (let x = 0; x < n_covs; x++) {
          let local_diag = xtx[x*n_covs + x];
          let local_rhs = xty[x];

          for (let y = 0; y < n_covs; y++)
            if (y !== x)
              local_rhs -= xtx[x*n_covs + y]*beta[y];

          beta[x] = (local_diag > 1e-12) ? Math.max(1e-4, local_rhs/local_diag) : 1e-4;
        }

      b_sum = Math.max(1e-8, beta[0] + beta[1] + beta[2]);
      b0_eff = 0.50*(beta[0]/b_sum) + 0.22;
      b1_eff = 0.50*(beta[1]/b_sum) + 0.20;
      b2_eff = 0.50*(beta[2]/b_sum) + 0.08;

      //Evaluate 5-arcminute covariate regression trend m_hat(x) on all inhabited cells
      for (let i = 0; i < n_valid; i++)
        if (u_hab[i] > 0)
          m_cell[i] = u_hab[i]*(b0_eff + b1_eff*u_nat[i] + b2_eff*u_eco[i]);

      //Evaluate meso-scale positive-cell regional mean m_macro(x) at tightened scale macro_rad
      m_macro = this.smoothPositiveFieldOnGrid(mask_data, m_cell, macro_rad);

      for (let i = 0; i < n_valid; i++)
        if (m_cell[i] > 0 && m_macro[i] > 0) {
          let local_ratio = Math.min(3.2, m_cell[i]/m_macro[i]);

          weights[i] = Math.pow(local_ratio, 2.25);
        }

      //Return statement
      return {
        beta: [
          Number(beta[0].toFixed(6)),
          Number(beta[1].toFixed(6)),
          Number(beta[2].toFixed(6))
        ],
        weights: weights
      };
    }


    /**
     * Fits the structural sill weights (c1, c2) (with c1 + c2 = 1, c1, c2 >= 0) of a two-scale Matérn (nu = 3/2) variogram model to the Matheron empirical variogram via Cressie (1985) / Zhang (1995) weighted least squares.
     * @alias SitesIARASResidualKriging.fitEmpiricalNestedVariogram
     *
     * @param {number[]} arg0_u_lags
     * @param {number[]} arg1_emp_gammas
     * @param {Array<number[]>} arg2_pair_bins
     * @param {number} arg3_tau1
     * @param {number} arg4_tau2
     * @param {number} arg5_c0_fraction
     *
     * @returns {Object}
     */
    static fitEmpiricalNestedVariogram (
      arg0_u_lags,
      arg1_emp_gammas,
      arg2_pair_bins,
      arg3_tau1,
      arg4_tau2,
      arg5_c0_fraction
    ) {
      //Convert from parameters
      let u_lags = arg0_u_lags;
      let emp_gammas = arg1_emp_gammas;
      let pair_bins = arg2_pair_bins;
      let tau1 = arg3_tau1;
      let tau2 = arg4_tau2;
      let c0_frac = arg5_c0_fraction;

      //Declare local instance variables
      let c1;
      let c2;
      let denom = 0;
      let emp_sill = 0;
      let n_bins = u_lags.length;
      let numer = 0;
      let sqrt3 = Math.sqrt(3);

      for (let i = n_bins - 3; i < n_bins; i++)
        emp_sill += emp_gammas[i]/3;
      emp_sill = Math.max(1e-8, emp_sill);

      for (let i = 0; i < n_bins; i++) {
        let local_s1 = sqrt3*u_lags[i]/tau1;
        let local_s2 = sqrt3*u_lags[i]/tau2;
        let local_f1 = 1 - (1 + local_s1)*Math.exp(-local_s1);
        let local_f2 = 1 - (1 + local_s2)*Math.exp(-local_s2);
        let local_df = local_f1 - local_f2;
        let local_g_norm = emp_gammas[i]/emp_sill;
        let local_nb = Math.max(1, pair_bins[i].length/3);
        let local_rhs = (local_g_norm - c0_frac)/Math.max(1e-6, 1 - c0_frac) - local_f2;
        let local_w = local_nb/Math.max(1e-6, u_lags[i]*local_g_norm*local_g_norm);

        numer += local_w*local_df*local_rhs;
        denom += local_w*local_df*local_df;
      }

      c1 = (denom > 1e-12) ? Math.max(0, Math.min(1, numer/denom)) : 0.5;
      c2 = 1 - c1;

      //Return statement
      return {
        c1: c1,
        c2: c2,
        empirical_sill: emp_sill
      };
    }


    /**
     * Loads and precomputes the static biophysical covariates (CLIMBER-3 maxln cultivable suitability u_nat, WWF forest-steppe ecotone suitability u_eco, composite HYDE 3.5 sub_iso / forest / Nelson partition IDs and 1900 fallback urban-masked HYDE 3.5 river/coastal rural habitation for active zero-HYDE raions).
     * @alias SitesIARASResidualKriging.loadBiophysicalCovariates
     *
     * @param {Object} arg0_mask_data
     * @param {Object} arg1_raion_data
     * @param {Object} arg2_config
     * @param {number} arg3_meso_px
     *
     * @returns {Object}
     */
    static loadBiophysicalCovariates (arg0_mask_data, arg1_raion_data, arg2_config, arg3_meso_px) {
      //Convert from parameters
      let mask_data = arg0_mask_data;
      let raion_data = arg1_raion_data;
      let config = arg2_config;
      let meso_px = arg3_meso_px;

      //Declare local instance variables
      let catchment_px = raion_data.catchment_smooth_radius_px;
      let clim_envelope = new Float32Array(mask_data.valid_cell_count);
      let cov_paths = config.kriging_config.covariate_paths;
      let f_forest_smooth;
      let f_pass1;
      let f_raw = new Float32Array(mask_data.valid_cell_count);
      let forest_grid;
      let grid_h = mask_data.grid_height;
      let grid_w = mask_data.grid_width;
      let hyde_rur_1900;
      let maxln_grid;
      let mean_maxln = 0;
      let n_raions = raion_data.raion_count;
      let n_valid = mask_data.valid_cell_count;
      let nelson_png;
      let next_pid = 1;
      let part_id = new Int32Array(mask_data.valid_cell_count);
      let part_map = new Map();
      let period_configs = config.periods;
      let raion_has_any_sites = new Uint8Array(raion_data.raion_count);
      let raion_list = raion_data.raion_list;
      let root = mask_data.project_root;
      let steppe_envelope = new Float32Array(mask_data.valid_cell_count);
      let sub_iso_grid;
      let total_pixels = mask_data.grid_width*mask_data.grid_height;
      let u_eco = new Float32Array(mask_data.valid_cell_count);
      let u_nat = new Float32Array(mask_data.valid_cell_count);
      let valid_indices = mask_data.valid_indices;

      sub_iso_grid = this.readAscGrid(path.join(root, cov_paths.sub_iso_asc), total_pixels);
      maxln_grid = this.readAscGrid(path.join(root, cov_paths.maxln_asc), total_pixels);
      forest_grid = this.readAscGrid(path.join(root, cov_paths.forest_asc), total_pixels);
      nelson_png = PNG.sync.read(fs.readFileSync(path.join(root, cov_paths.nelson_regions_png)));

      hyde_rur_1900 = this.loadUrbanMaskedHYDEPopcRaster(mask_data, 1900, null, config);

      for (let i = 0; i < n_raions; i++)
        for (let x = 0; x < period_configs.length; x++)
          if ((raion_list[i].periods[period_configs[x].key] || 0) > 0) {
            raion_has_any_sites[i] = 1;
            break;
          }

      for (let i = 0; i < n_valid; i++) {
        let local_f = (forest_grid[valid_indices[i]] > 0) ? 1 : 0;
        let local_gidx = valid_indices[i];
        let local_idx = local_gidx*4;
        let local_key;
        let local_nid = (nelson_png.data[local_idx] << 16) | (nelson_png.data[local_idx + 1] << 8) | nelson_png.data[local_idx + 2];
        let local_p = Math.round(sub_iso_grid[local_gidx]);
        let local_pid;

        local_key = `${local_p}_${local_nid}`;
        local_pid = part_map.get(local_key);
        if (!local_pid) {
          local_pid = next_pid++;
          part_map.set(local_key, local_pid);
        }
        part_id[i] = local_pid;

        f_raw[i] = local_f;
        mean_maxln += Math.pow(Math.max(0, maxln_grid[local_gidx]), 0.80);
      }
      mean_maxln = Math.max(1e-4, mean_maxln/n_valid);

      f_pass1 = this.smoothValidFieldOnGrid(mask_data, f_raw, Math.max(2, catchment_px));
      f_forest_smooth = this.smoothValidFieldOnGrid(mask_data, f_pass1, Math.max(2, catchment_px));

      for (let i = 0; i < n_valid; i++) {
        let local_ff = Math.max(0, Math.min(1, f_forest_smooth[i]));
        let local_gidx = valid_indices[i];
        let local_hermite = local_ff*local_ff*(3 - 2*local_ff);
        let local_is_crimea = false;
        let local_lat = 90 - (Math.floor(local_gidx/grid_w) + 0.5)*(180/grid_h);
        let local_lon = -180 + ((local_gidx % grid_w) + 0.5)*(360/grid_w);
        let local_unat = Math.pow(Math.max(0, maxln_grid[local_gidx]), 0.80)/mean_maxln;

        if (
          local_lat >= 44.35 &&
          local_lat <= 46.23 &&
          local_lon >= 32.45 &&
          local_lon <= 36.68 &&
          !(local_lat > 45.45 && local_lon > 35.25)
        ) local_is_crimea = true;

        u_nat[i] = local_unat;
        u_eco[i] = 4*local_ff*(1 - local_ff);
        clim_envelope[i] = 1.0;

        //Pre-1700 AD Wild Fields & Pontic-Caspian steppe envelope across Southern Russia & Russian Donbas (exempting Crimea)
        if (local_is_crimea) {
          steppe_envelope[i] = (local_lat < 45.35 || local_lon > 35.15 || local_lon < 33.65) ? 1.0 : 0.85;
        } else if (local_lat < 53.5 && local_lon < 54.0) {
          let local_lat_w = Math.max(0, Math.min(1, (53.5 - local_lat)/2.5));
          let local_lon_w = Math.max(0, Math.min(1, (54.0 - local_lon)/4.0));
          let local_region_w = local_lat_w*local_lon_w;
          let local_steppe_val = 0.25 + 0.75*(0.85*local_hermite + 0.15*Math.min(1, 0.75*local_unat));

          steppe_envelope[i] = 1 - local_region_w*(1 - local_steppe_val);
        } else {
          steppe_envelope[i] = 1.0;
        }
      }

      //Return statement
      return {
        catchment_px: catchment_px,
        clim_envelope: clim_envelope,
        forest_grid: forest_grid,
        hyde_rur_1900: hyde_rur_1900,
        meso_px: meso_px,
        part_id: part_id,
        partition_count: next_pid,
        raion_has_any_sites: raion_has_any_sites,
        steppe_envelope: steppe_envelope,
        sub_iso_grid: sub_iso_grid,
        u_eco: u_eco,
        u_nat: u_nat
      };
    }
  };
}

module.exports = global.SitesIARASResidualKriging;
